import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes, users, teamMembers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Resolve a volume the caller may act on.
 *
 * The membership check used to be written `role !== 'admin' && volume.teamId`,
 * which skips it entirely when the volume has no team — so every volume created
 * without one (the POST route allowed that) was readable, editable and deletable
 * by any authenticated user. A teamless volume is now admin-only: it belongs to
 * nobody, so nobody but an operator should reach it.
 *
 * `needOwner` distinguishes reading from writing, matching what the handlers
 * enforced before.
 *
 * 404 for a volume the caller cannot see at all — another team's, or a teamless
 * one — so the route does not double as an id oracle, which is the same rule
 * `/api/stacks/[id]` follows. 403 is kept for the one case where it says
 * something true and useful: a member of the owning team who can read the volume
 * and needs the `owner` role to change it.
 */
type VolumeAccess =
  | { ok: false; response: Response }
  | { ok: true; userId: string; volume: typeof volumes.$inferSelect };

async function requireVolumeAccess(
  cookies: any,
  volumeId: string,
  needOwner: boolean,
): Promise<VolumeAccess> {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const deny = (message: string, status: number): VolumeAccess => ({
    ok: false,
    response: json({ error: message }, { status }),
  });

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) return deny('Unauthorized', 401);

  const volume = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  if (!volume) return deny('Volume not found', 404);

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.role !== 'admin') {
    if (!volume.teamId) return deny('Volume not found', 404);

    const membership = await db.select().from(teamMembers)
      .where(and(eq(teamMembers.teamId, volume.teamId), eq(teamMembers.userId, userId)))
      .get();

    if (!membership) return deny('Volume not found', 404);
    if (needOwner && membership.role !== 'owner') {
      return deny('Access denied - owner role required', 403);
    }
  }

  return { ok: true, userId, volume };
}

export const GET: RequestHandler = async ({ params, cookies }) => {
  const auth = await requireVolumeAccess(cookies, params.id, false);
  if (!auth.ok) return auth.response;

  return json(auth.volume);
};

export const PATCH: RequestHandler = async ({ params, request, cookies }) => {
  const auth = await requireVolumeAccess(cookies, params.id, true);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const allowedFields = ['name', 'containerPath', 'sizeLimit', 'workerId'];
  const updates: Record<string, any> = { updatedAt: new Date() };

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  await db.update(volumes).set(updates).where(eq(volumes.id, params.id));

  const updated = await db.select().from(volumes).where(eq(volumes.id, params.id)).get();
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, cookies }) => {
  const auth = await requireVolumeAccess(cookies, params.id, true);
  if (!auth.ok) return auth.response;

  await db.delete(volumes).where(eq(volumes.id, params.id));
  
  return json({ success: true, message: 'Volume deleted' });
};
