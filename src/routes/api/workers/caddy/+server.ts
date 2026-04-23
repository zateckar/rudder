import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey, executeSSHCommand, createTempKeyFile, deleteTempKeyFile } from '$lib/server/ssh';
import { generateTraefikConfig } from '$lib/server/provisioning';

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

  const body = await request.json();
  const { workerId, apps, action } = body;

  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  
  if (!worker || !worker.sshKeyId) {
    return json({ error: 'Worker not found or not configured' }, { status: 404 });
  }

  const sshKey = await getSSHKey(worker.sshKeyId);
  if (!sshKey) {
    return json({ error: 'SSH key not found' }, { status: 404 });
  }

  let tempKeyPath: string | undefined;
  
  try {
    tempKeyPath = createTempKeyFile(sshKey.privateKey);

    if (action === 'reload') {
      // Just reload Traefik - it will automatically detect new containers with labels
      const result = await executeSSHCommand(
        {
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        },
        'systemctl reload traefik'
      );

      if (result.exitCode !== 0) {
        console.error('Traefik reload failed:', result.stderr);
        return json({ error: 'Failed to reload Traefik: ' + result.stderr }, { status: 500 });
      }

      return json({ success: true, message: 'Traefik configuration reloaded' });
    } else if (action === 'config' && apps && Array.isArray(apps)) {
      // Generate and apply a complete Traefik configuration (for manual override)
      const traefikConfig = generateTraefikConfig('example.com', apps);
      const encodedConfig = Buffer.from(traefikConfig).toString('base64');

      const result = await executeSSHCommand(
        {
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        },
        `echo "${encodedConfig}" | base64 -d > /etc/traefik/dynamic/manual.yml && systemctl reload traefik`
      );

      if (result.exitCode !== 0) {
        console.error('Traefik config failed:', result.stderr);
        return json({ error: 'Failed to apply Traefik configuration: ' + result.stderr }, { status: 500 });
      }

      return json({ success: true, message: 'Traefik configuration applied' });
    } else {
      // Default action: just reload Traefik since it should auto-detect container labels
      return await POST({
        request: new Request(request.url, {
          method: 'POST',
          body: JSON.stringify({ workerId, action: 'reload' })
        }),
        cookies,
        locals
      });
    }
  } catch (error: any) {
    console.error('Traefik config error:', error);
    return json({ error: error.message }, { status: 500 });
  } finally {
    if (tempKeyPath) {
      deleteTempKeyFile(tempKeyPath);
    }
  }
}
