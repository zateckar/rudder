import { redirect, fail } from '@sveltejs/kit';
import { db, safeUserColumns } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select(safeUserColumns).from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') {
    throw redirect(303, '/dashboard');
  }

  return {
    user: currentUser,
  };
};

export const actions = {
  default: async ({ request, cookies }: { request: Request; cookies: any }) => {
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

    const formData = await request.formData();
    const name = formData.get('name')?.toString();
    const hostname = formData.get('hostname')?.toString();
    const sshPort = parseInt(formData.get('sshPort')?.toString() || '22');
    const sshUser = formData.get('sshUser')?.toString();
    const baseDomain = formData.get('baseDomain')?.toString() || '';

    if (!name || !hostname || !sshUser) {
      return fail(400, { error: 'Missing required fields' });
    }

    const workerId = crypto.randomUUID();

    // Derive podman API URL from base domain or fall back to IP-based
    const podmanApiUrl = baseDomain
      ? `https://podman-api.${baseDomain}`
      : `https://${hostname}`;

    await db.insert(workers).values({
      id: workerId,
      name,
      hostname,
      sshPort,
      sshUser,
      baseDomain: baseDomain || null,
      podmanApiUrl,
      status: 'offline',
      createdAt: new Date(),
    });

    throw redirect(303, '/workers');
  }
};
