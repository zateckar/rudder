import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
import { parseJsonBody, schemas } from '$lib/server/validation';
import { requireWorker, route } from '$lib/server/auth';

export const POST: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const body = await parseJsonBody(event.request, schemas.terminalCommand);
  const { command } = body;

  // SSH key must be provided ad-hoc in the request body (never stored server-side)
  const privateKey = body.sshPrivateKey;
  if (!privateKey) {
    return json({ error: 'SSH key required — provide sshPrivateKey in request body' }, { status: 400 });
  }

  const sshConfig: SSHConnectionConfig = {
    host: worker.hostname,
    port: worker.sshPort,
    username: worker.sshUser,
    privateKey,
  };

  const result = await executeSSHCommand(sshConfig, command);
  return json({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
});
