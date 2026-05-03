import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey, executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';

export const POST: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  let body;
  try {
    body = await parseJsonBody(request, schemas.terminalCommand);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { command } = body;

  try {
    // Accept ad-hoc SSH key from request body (never stored)
    const adHocKey = body.sshPrivateKey;
    let privateKey: string;

    if (adHocKey) {
      privateKey = adHocKey;
    } else if (worker.sshKeyId) {
      const sshKey = await getSSHKey(worker.sshKeyId);
      if (!sshKey) return json({ error: 'SSH key not found' }, { status: 500 });
      privateKey = sshKey.privateKey;
    } else {
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
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
