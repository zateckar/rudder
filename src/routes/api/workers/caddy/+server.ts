import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { executeSSHCommand } from '$lib/server/ssh';
import { requireWorker, route } from '$lib/server/auth';

/**
 * POST /api/workers/caddy — restart Traefik on a worker.
 *
 * Traefik picks up application routes from container labels and dynamic files
 * on its own, so this is only a manual recovery hatch. The former `config`
 * action, which generated a whole `manual.yml` against a hardcoded
 * `example.com`, has been removed: it could only ever write routes for the
 * wrong domain, and shadowed the real label-derived ones.
 *
 * The path is a fossil — Rudder used Caddy before Traefik, and the worker page
 * still calls this URL. Renaming it is a UI change as well as a route move, so
 * it is left alone rather than half-done.
 */
export const POST: RequestHandler = route(async (event) => {
  const { workerId, sshPrivateKey } = await event.request.json();

  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }
  if (!sshPrivateKey) {
    return json(
      { error: 'SSH private key required for Traefik management. Provide sshPrivateKey in the request body.' },
      { status: 400 },
    );
  }

  const { worker } = await requireWorker(event, workerId);

  // The unit runs Traefik in a container and defines no ExecReload, so
  // `systemctl reload` would fail — restart is the supported operation.
  const result = await executeSSHCommand(
    {
      host: worker.hostname,
      port: worker.sshPort,
      username: worker.sshUser,
      privateKey: sshPrivateKey,
    },
    'sudo systemctl restart traefik-container.service',
  );

  if (result.exitCode !== 0) {
    console.error('Traefik restart failed:', result.stderr);
    return json({ error: 'Failed to restart Traefik: ' + result.stderr }, { status: 500 });
  }

  return json({ success: true, message: 'Traefik restarted' });
});
