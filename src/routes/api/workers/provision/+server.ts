import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers, sshKeys, applications } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey, executeSSHCommand, createTempKeyFile, deleteTempKeyFile, testSSHConnection } from '$lib/server/ssh';
import { generateProvisioningScript } from '$lib/server/provisioning';
import { env } from '$lib/server/env';
import { randomBytes } from 'crypto';
import { withLock, LockError } from '$lib/server/locks';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';

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

  const { workerId } = body;

  try {
    return await withLock(
      `worker:${workerId}:provision`,
      { operation: 'worker-provisioning', holder: userId },
      async () => {
        const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
        
        if (!worker) {
          return json({ error: 'Worker not found' }, { status: 404 });
        }

        if (!worker.sshKeyId) {
          return json({ error: 'No SSH key configured' }, { status: 400 });
        }

        if (worker.status === 'provisioning') {
          return json({ error: 'Worker is already being provisioned' }, { status: 409 });
        }

        const sshKey = await getSSHKey(worker.sshKeyId);
        if (!sshKey) {
          return json({ error: 'SSH key not found' }, { status: 404 });
        }

        let tempKeyPath: string | undefined;
        
        try {
          tempKeyPath = createTempKeyFile(sshKey.privateKey);
          
          const canConnect = await testSSHConnection({
            host: worker.hostname,
            port: worker.sshPort,
            username: worker.sshUser,
            privateKey: sshKey.privateKey,
          });

          console.log('SSH connection test result:', canConnect);

          if (!canConnect) {
            await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
            return json({ error: 'SSH connection failed' }, { status: 500 });
          }

          const bouncerKey = randomBytes(20).toString('hex');

          const script = generateProvisioningScript(
            worker.name,
            worker.sshPort,
            env.PUBLIC_URL,
            worker.baseDomain || undefined,
            bouncerKey
          );
          
          const result = await executeSSHCommand(
            {
              host: worker.hostname,
              port: worker.sshPort,
              username: worker.sshUser,
              privateKey: sshKey.privateKey,
            },
            `sudo bash -s`,
            script
          );

          console.log('SSH exec result - exitCode:', result.exitCode, 'stdout:', result.stdout.substring(0, 500), 'stderr:', result.stderr.substring(0, 200));

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
              podmanClientKey: certs.clientKey,
            } : {}),
            crowdsecBouncerKey: storedBouncerKey,
            provisionedAt: new Date(),
            lastSeenAt: new Date(),
          }).where(eq(workers.id, workerId));

          // Auto-redeploy all applications assigned to this worker
          const workerApps = await db.select().from(applications).where(eq(applications.workerId, workerId)).all();
          const { executeApplicationDeploy } = await import('$lib/server/deploy');
          const redeployResults: string[] = [];
          for (const app of workerApps) {
            try {
              const result = await executeApplicationDeploy(app.id, userId);
              redeployResults.push(`${app.name}: ${result.success ? 'ok' : result.message}`);
            } catch (e: any) {
              redeployResults.push(`${app.name}: ${e.message}`);
            }
          }
          if (redeployResults.length > 0) {
            console.log(`Auto-redeploy after provisioning: ${redeployResults.join(', ')}`);
          }

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
