import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes, teamMembers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { AuthorizationError, requireUser, route } from '$lib/server/auth';

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
async function requireVolume(
  event: { locals: App.Locals },
  volumeId: string,
  needOwner: boolean,
): Promise<typeof volumes.$inferSelect> {
  const ctx = requireUser(event);

  const volume = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  if (!volume) throw new AuthorizationError('Volume not found', 404);

  if (ctx.user.role !== 'admin') {
    if (!volume.teamId) throw new AuthorizationError('Volume not found', 404);

    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, volume.teamId), eq(teamMembers.userId, ctx.user.id)))
      .get();

    if (!membership) throw new AuthorizationError('Volume not found', 404);
    if (needOwner && membership.role !== 'owner') {
      throw new AuthorizationError('Access denied - owner role required', 403);
    }
  }

  return volume;
}

export const GET: RequestHandler = route(async (event) => {
  return json(await requireVolume(event, event.params.id!, false));
});

export const PATCH: RequestHandler = route(async (event) => {
  const volumeId = event.params.id!;
  await requireVolume(event, volumeId, true);

  const body = await event.request.json();
  const allowedFields = ['name', 'containerPath', 'sizeLimit', 'workerId'] as const;
  const updates: Record<string, any> = { updatedAt: new Date() };

  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  await db.update(volumes).set(updates).where(eq(volumes.id, volumeId));

  const updated = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  return json(updated);
});

export const DELETE: RequestHandler = route(async (event) => {
  const volumeId = event.params.id!;
  await requireVolume(event, volumeId, true);

  await db.delete(volumes).where(eq(volumes.id, volumeId));

  return json({ success: true, message: 'Volume deleted' });
});
