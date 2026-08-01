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

  const { workerId, sshPrivateKey: adHocKey } = body;

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

          const workerOidcConfig = (worker.oidcEnabled && worker.oidcProviderUrl && worker.oidcClientId && worker.oidcClientSecret)
            ? {
                providerURL: worker.oidcProviderUrl,
                clientID: worker.oidcClientId,
                clientSecret: decryptField(worker.oidcClientSecret) || '',
                encryptionKey: decryptField(worker.oidcEncryptionKey) || '',
              }
            : undefined;

          const script = generateProvisioningScript(
            worker.name,
            worker.baseDomain || undefined,
            bouncerKey,
            workerOidcConfig
          );
          
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

          console.log('SSH exec result - exitCode:', result.exitCode, 'stdout (last 2000):', result.stdout.substring(Math.max(0, result.stdout.length - 2000)), 'stderr:', result.stderr.substring(0, 500));

          if (result.exitCode !== 0) {
            console.error('Provisioning failed:', result.stderr);
            await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
            return json({ error: 'Provisioning failed: ' + result.stderr }, { status: 500 });
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
            provisionedAt: new Date(),
            lastSeenAt: new Date(),
          }).where(eq(workers.id, workerId));

          // Discover and import existing applications
          // Skip discovery during initial provisioning - Let's Encrypt certificates take 30-60s to obtain
          // Discovery will run automatically on the next metrics collection cycle (every 5 minutes)
          let discoveryResults = { appsDiscovered: 0, teamsCreated: 0, stacksCreated: 0 };
          console.log(
            '[app-discovery] Skipping during provisioning - Traefik needs time to obtain Let\'s Encrypt certificates. ' +
            'Discovery will run on the next metrics collection cycle.'
          );

          return json({
            success: true,
            message: 'Worker provisioned successfully',
            mtlsEnabled: hasCerts,
            appsDiscovered: discoveryResults.appsDiscovered,
            teamsCreated: discoveryResults.teamsCreated,
            stacksCreated: discoveryResults.stacksCreated,
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
