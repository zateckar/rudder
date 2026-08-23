import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { volumes, teamMembers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { isTeamMember, requireUser, route } from '$lib/server/auth';
import { parseJsonBody, schemas } from '$lib/server/validation';

export const GET: RequestHandler = route(async (event) => {
  const ctx = requireUser(event);
  const teamId = event.url.searchParams.get('teamId');

  if (ctx.user.role === 'admin') {
    const rows = teamId
      ? await db.select().from(volumes).where(eq(volumes.teamId, teamId)).all()
      : await db.select().from(volumes).all();
    return json(rows);
  }

  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, ctx.user.id))
    .all();
  const teamIds = memberships.map((t) => t.teamId);

  if (teamId) {
    if (!teamIds.includes(teamId)) {
      return json({ error: 'Access denied to this team' }, { status: 403 });
    }
    return json(await db.select().from(volumes).where(eq(volumes.teamId, teamId)).all());
  }

  // Filtered in SQL, not afterwards: this used to `SELECT *` every volume in the
  // installation and drop the ones the caller could not see in JavaScript.
  if (teamIds.length === 0) return json([]);
  return json(await db.select().from(volumes).where(inArray(volumes.teamId, teamIds)).all());
});

export const POST: RequestHandler = route(async (event) => {
  const ctx = requireUser(event);

  // `schemas.createVolume` states the same rules the hand-written checks did —
  // including that an owning team is required, which is what stops a teamless
  // volume being reachable by every authenticated user.
  const { name, teamId, workerId, containerPath, sizeLimit } = await parseJsonBody(
    event.request,
    schemas.createVolume,
  );

  if (ctx.user.role !== 'admin' && !(await isTeamMember(ctx.user.id, teamId))) {
    return json({ error: 'Access denied to this team' }, { status: 403 });
  }

  const volumeId = crypto.randomUUID();
  const now = new Date();

  await db.insert(volumes).values({
    id: volumeId,
    name,
    teamId,
    workerId: workerId || null,
    containerPath,
    sizeLimit: sizeLimit || null,
    createdAt: now,
    updatedAt: now,
  });

  const created = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
  return json(created, { status: 201 });
});
