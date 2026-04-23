import { redirect, fail, error } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers, users, sshKeys } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const load = async ({ params, cookies }: { params: { id: string }; cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') {
    throw redirect(303, '/dashboard');
  }

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) throw error(404, 'Worker not found');

  const allSshKeys = await db.select().from(sshKeys).all();

  return {
    user: currentUser,
    worker,
    sshKeys: allSshKeys,
  };
};

export const actions = {
  default: async ({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const currentUser = await db.select().from(users).where(eq(users.id, userId!)).get();
    if (!currentUser || currentUser.role !== 'admin') {
      return fail(403, { error: 'Admin access required' });
    }

    const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
    if (!worker) return fail(404, { error: 'Worker not found' });

    const formData = await request.formData();

    const name = formData.get('name')?.toString();
    const hostname = formData.get('hostname')?.toString();
    const sshPort = parseInt(formData.get('sshPort')?.toString() || '22');
    const sshUser = formData.get('sshUser')?.toString();
    const sshKeyId = formData.get('sshKeyId')?.toString();
    const baseDomain = formData.get('baseDomain')?.toString() || '';
    const podmanApiUrl = formData.get('podmanApiUrl')?.toString() || '';

    if (!name || !hostname || !sshUser) {
      return fail(400, { error: 'Missing required fields' });
    }

    const updates: Record<string, any> = {
      name,
      hostname,
      sshPort,
      sshUser,
      baseDomain: baseDomain || null,
      podmanApiUrl: podmanApiUrl || (baseDomain ? `https://podman-api.${baseDomain}` : `https://${hostname}`),
    };

    if (sshKeyId) {
      updates.sshKeyId = sshKeyId;
    }

    await db.update(workers).set(updates).where(eq(workers.id, params.id));

    throw redirect(303, `/workers/${params.id}`);
  },
};
