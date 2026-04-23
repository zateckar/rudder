import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers, sshKeys } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { env } from '$lib/server/env';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';

export async function GET({ cookies, locals }: { cookies: any; locals: any }) {
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

  const allWorkers = await db.select().from(workers).all();
  return json(allWorkers);
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
    body = await parseJsonBody(request, schemas.createWorker);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { name, hostname, sshPort, sshUser, sshKeyId, baseDomain, labels } = body;

  const workerId = uuid();

  await db.insert(workers).values({
    id: workerId,
    name,
    hostname,
    sshPort,
    sshUser,
    sshKeyId,
    podmanApiUrl: `ssh://${hostname}:${sshPort}`,
    status: 'provisioning',
    createdAt: new Date(),
    baseDomain,
    labels: labels ? JSON.stringify(labels) : null,
  });

  return json({ id: workerId, status: 'provisioning' });
}
