import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, applications, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require admin role for worker details
  if (locals.userRole !== 'admin') {
    return json({ error: 'Forbidden - admin access required' }, { status: 403 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  // Remove sensitive data
  return json({
    ...worker,
    podmanClientKey: undefined,
    podmanCaCert: worker.podmanCaCert ? '***' : null,
    podmanClientCert: worker.podmanClientCert ? '***' : null,
  });
};

export const PATCH: RequestHandler = async ({ params, request, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role
  const { users } = await import('$lib/db/schema');
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') {
    return json({ error: 'Admin access required' }, { status: 403 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  const body = await request.json();
  const allowedFields = ['name', 'hostname', 'sshPort', 'sshUser', 'sshKeyId', 'labels', 'status'];
  const updates: Record<string, any> = {};

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }

  await db.update(workers).set(updates).where(eq(workers.id, params.id));

  const updated = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  
  return json({
    ...updated,
    podmanClientKey: undefined,
    podmanCaCert: updated?.podmanCaCert ? '***' : null,
    podmanClientCert: updated?.podmanClientCert ? '***' : null,
  });
};

export const DELETE: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role
  const { users } = await import('$lib/db/schema');
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') {
    return json({ error: 'Admin access required' }, { status: 403 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  // Check for existing applications/containers
  const workerApps = await db.select().from(applications).where(eq(applications.workerId, params.id)).all();
  const workerContainers = await db.select().from(containers).where(eq(containers.workerId, params.id)).all();

  if (workerApps.length > 0 || workerContainers.length > 0) {
    return json({ 
      error: 'Cannot delete worker with existing applications or containers',
      applications: workerApps.length,
      containers: workerContainers.length
    }, { status: 409 });
  }

  await db.delete(workers).where(eq(workers.id, params.id));
  
  return json({ success: true, message: 'Worker deleted' });
};
