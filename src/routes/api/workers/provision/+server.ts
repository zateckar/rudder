import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand, createTempKeyFile, deleteTempKeyFile, testSSHConnection } from '$lib/server/ssh';
import { generateProvisioningScript } from '$lib/server/provisioning';
import { env } from '$lib/server/env';
import { randomBytes } from 'crypto';
import { withLock, LockError } from '$lib/server/locks';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';
import { encryptField, decryptField } from '$lib/server/encryption';
import { normalizeOidcSecret } from '$lib/server/oidc';
import { redactProvisioningOutput } from '$lib/server/redaction';
import {
  checkPublicUrlReachable,
  configEndpointUrl,
  generateConfigToken,
} from '$lib/server/worker-config-endpoint';

/** Parse mTLS certificates and bouncer key from provisioning script stdout */
function parseCertsFromOutput(stdout: string): {
  caCert: string | null;
  clientCert: string | null;
  clientKey: string | null;
  bouncerKey: string | null;
} {
  const result = { caCert: null as string | null, clientCert: null as string | null, clientKey: null as string | null, bouncerKey: null as string | null };

  try {
    const caMatch = stdout.match(/^CA_CERT_B64=(.+)$/m);
    const clientCertMatch = stdout.match(/^CLIENT_CERT_B64=(.+)$/m);
    const clientKeyMatch = stdout.match(/^CLIENT_KEY_B64=(.+)$/m);
    const bouncerKeyMatch = stdout.match(/^BOUNCER_KEY=(.+)$/m);

    if (caMatch?.[1]) {
      result.caCert = Buffer.from(caMatch[1].trim(), 'base64').toString('utf-8');
    }
    if (clientCertMatch?.[1]) {
      result.clientCert = Buffer.from(clientCertMatch[1].trim(), 'base64').toString('utf-8');
    }
    if (clientKeyMatch?.[1]) {
      result.clientKey = Buffer.from(clientKeyMatch[1].trim(), 'base64').toString('utf-8');
    }
    if (bouncerKeyMatch?.[1]) {
      result.bouncerKey = bouncerKeyMatch[1].trim();
    }
  } catch (e) {
    console.error('Failed to parse certs from provisioning output:', e);
  }

  return result;
}

export async function POST({ request, cookies, locals }: { request: Request; cookies: any; locals: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require admin role
  if (locals.userRole !== 'admin') {
    return json({ error: 'Forbidden - admin access required' }, { status: 403 });
  }

  let body;
  try {
    body = await parseJsonBody(request, schemas.provisionWorker);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { workerId, sshPrivateKey: adHocKey, applyUpdates } = body;

  try {
    return await withLock(
      `worker:${workerId}:provision`,
      { operation: 'worker-provisioning', holder: userId },
      async () => {
        const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
        
        if (!worker) {
          return json({ error: 'Worker not found' }, { status: 404 });
        }

        if (!adHocKey) {
          return json({ error: 'No SSH key provided. Paste the SSH private key in the provisioning dialog.' }, { status: 400 });
        }

        if (worker.status === 'provisioning') {
          return json({ error: 'Worker is already being provisioned' }, { status: 409 });
        }

        const privateKey = adHocKey;

        let tempKeyPath: string | undefined;
        
        try {
          tempKeyPath = createTempKeyFile(privateKey);
          
          const canConnect = await testSSHConnection({
            host: worker.hostname,
            port: worker.sshPort,
            username: worker.sshUser,
            privateKey,
          });

          console.log('SSH connection test result:', canConnect);

          if (!canConnect) {
            await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
            return json({ error: 'SSH connection failed' }, { status: 500 });
          }

          const bouncerKey =
            decryptField(worker.crowdsecBouncerKey) || randomBytes(20).toString('hex');

          // Only ship an OIDC middleware when it can actually be built: the
          // plugin needs a base domain for the shared callback host and a
          // 32-character secret, and a middleware that fails to build makes
          // Traefik discard the whole dynamic file.
          const oidcComplete = !!(
            worker.oidcEnabled &&
            worker.oidcProviderUrl &&
            worker.oidcClientId &&
            worker.oidcClientSecret &&
            worker.baseDomain
          );
          const oidcClientSecret = oidcComplete ? decryptField(worker.oidcClientSecret) : null;
          const oidcSecret = oidcComplete
            ? normalizeOidcSecret(decryptField(worker.oidcEncryptionKey))
            : null;

          if (oidcSecret?.rotated) {
            await db.update(workers)
              .set({ oidcEncryptionKey: encryptField(oidcSecret.secret) })
              .where(eq(workers.id, worker.id));
          }

          const workerOidcConfig = (oidcComplete && oidcClientSecret && oidcSecret)
            ? {
                providerURL: worker.oidcProviderUrl!,
                clientID: worker.oidcClientId!,
                clientSecret: oidcClientSecret,
                secret: oidcSecret.secret,
              }
            : undefined;

          // Workers in http routing mode fetch their routes from the control
          // plane, so provisioning has to plant an endpoint and a credential.
          // Refuse rather than provision a worker that will quietly serve
          // nothing because it cannot reach us.
          let routingConfig: { endpoint: string; token: string } | undefined;
          if (worker.routingMode === 'http') {
            const unreachable = checkPublicUrlReachable();
            if (unreachable) {
              await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
              return json({ error: unreachable }, { status: 400 });
            }
            // Re-provisioning rotates the token: the old one may be on a host
            // that is being rebuilt, and nothing else depends on its value.
            const token = generateConfigToken();
            await db.update(workers)
              .set({ configToken: encryptField(token) })
              .where(eq(workers.id, workerId));
            routingConfig = { endpoint: configEndpointUrl(worker.id, env.PUBLIC_URL), token };
          }

          const script = generateProvisioningScript(worker.name, {
            baseDomain: worker.baseDomain || undefined,
            bouncerKey,
            oidcConfig: workerOidcConfig,
            sshPort: worker.sshPort,
            routingConfig,
            applyUpdates,
          });
          
          const result = await executeSSHCommand(
            {
              host: worker.hostname,
              port: worker.sshPort,
              username: worker.sshUser,
              privateKey,
            },
            `sudo bash -s`,
            script
          );

          // The script echoes the mTLS client key and the bouncer key on stdout;
          // logging that tail verbatim wrote a worker's root-equivalent private
          // key into the application log on every provisioning run.
          console.log(
            'SSH exec result - exitCode:', result.exitCode,
            'stdout (last 2000):',
            redactProvisioningOutput(result.stdout.substring(Math.max(0, result.stdout.length - 2000))),
            'stderr:', redactProvisioningOutput(result.stderr.substring(0, 500)),
          );

          if (result.exitCode !== 0) {
            // stderr is redacted for the same reason as stdout, and again on the
            // way out: this string is rendered in the provisioning dialog.
            const failure = redactProvisioningOutput(result.stderr);
            console.error('Provisioning failed:', failure);
            await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
            return json({ error: 'Provisioning failed: ' + failure }, { status: 500 });
          }

          const certs = parseCertsFromOutput(result.stdout);
          const hasCerts = !!(certs.caCert && certs.clientCert && certs.clientKey);
          const storedBouncerKey = certs.bouncerKey || bouncerKey;

          if (hasCerts) {
            console.log('mTLS certificates obtained from provisioning output');
          } else {
            console.warn('No mTLS certificates found in provisioning output - Podman API may not be secured');
          }

          if (storedBouncerKey) {
            console.log('CrowdSec bouncer key obtained');
          }

          const newPodmanApiUrl = worker.baseDomain
            ? `https://podman-api.${worker.baseDomain}`
            : `https://${worker.hostname}`;

          await db.update(workers).set({ 
            status: 'online',
            podmanApiUrl: newPodmanApiUrl,
            ...(hasCerts ? {
              podmanCaCert: certs.caCert,
              podmanClientCert: certs.clientCert,
              // Private key material is encrypted at rest; the CA and client
              // certificates are public halves and stay readable.
              podmanClientKey: encryptField(certs.clientKey),
            } : {}),
            crowdsecBouncerKey: encryptField(storedBouncerKey),
            // Provisioning writes global-oidc.yml itself when the config is
            // complete, so deploys may attach the middleware from now on.
            ...(workerOidcConfig ? { oidcAppliedAt: new Date() } : {}),
            provisionedAt: new Date(),
            lastSeenAt: new Date(),
          }).where(eq(workers.id, workerId));

          // Provisioning no longer imports anything. Containers already on the
          // machine are offered for adoption on the worker's page, where a person
          // chooses which of them Rudder should manage. The counts this used to
          // return were always zero anyway — discovery was deferred to the metrics
          // cycle, so the response reported an import that had not happened yet.
          return json({
            success: true,
            message: 'Worker provisioned successfully',
            mtlsEnabled: hasCerts,
          });
        } catch (error: any) {
          console.error('Provisioning error:', error);
          await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
          return json({ error: error.message }, { status: 500 });
        } finally {
          if (tempKeyPath) {
            deleteTempKeyFile(tempKeyPath);
          }
        }
      }
    );
  } catch (error) {
    if (error instanceof LockError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
