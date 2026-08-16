import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand } from '$lib/server/ssh';

/**
 * POST /api/workers/caddy — restart Traefik on a worker.
 *
 * Traefik picks up application routes from container labels and dynamic files
 * on its own, so this is only a manual recovery hatch.  The former `config`
 * action, which generated a whole `manual.yml` against a hardcoded
 * `example.com`, has been removed: it could only ever write routes for the
 * wrong domain, and shadowed the real label-derived ones.
 */
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
  const { workerId, sshPrivateKey } = body;

  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  if (!sshPrivateKey) {
    return json({ error: 'SSH private key required for Traefik management. Provide sshPrivateKey in the request body.' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();

  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    // The unit runs Traefik in a container and defines no ExecReload, so
    // `systemctl reload` would fail — restart is the supported operation.
    const result = await executeSSHCommand(
      {
        host: worker.hostname,
        port: worker.sshPort,
        username: worker.sshUser,
        privateKey: sshPrivateKey,
      },
      'sudo systemctl restart traefik-container.service'
    );

    if (result.exitCode !== 0) {
      console.error('Traefik restart failed:', result.stderr);
      return json({ error: 'Failed to restart Traefik: ' + result.stderr }, { status: 500 });
    }

    return json({ success: true, message: 'Traefik restarted' });
  } catch (error: any) {
    console.error('Traefik restart error:', error);
    return json({ error: error.message }, { status: 500 });
  }
}
