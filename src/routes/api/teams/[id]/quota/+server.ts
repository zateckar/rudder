import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teamQuotas, teams, applications, containers } from '$lib/db/schema';
import { eq, inArray, count } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireTeam, requireAdminUser, route } from '$lib/server/auth';

/** GET: Return quota for this team + current usage */
export const GET: RequestHandler = route(async (event) => {
  const teamId = event.params.id!;
  // Quota and usage describe a team's footprint — restrict to its members.
  await requireTeam(event, teamId);

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return json({ error: 'Team not found' }, { status: 404 });

  const quota = await db.select().from(teamQuotas).where(eq(teamQuotas.teamId, teamId)).get();

  // Count current usage. One aggregate rather than a query per application:
  // this ran `SELECT * FROM containers` once per app and counted the rows in
  // JavaScript, which is N+1 queries to learn a number SQLite will produce in
  // one — and it materialised every column of every container to do it.
  const teamApps = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.teamId, teamId))
    .all();
  const appIds = teamApps.map((a) => a.id);

  const containerCount =
    appIds.length > 0
      ? (
          await db
            .select({ n: count() })
            .from(containers)
            .where(inArray(containers.applicationId, appIds))
            .get()
        )?.n ?? 0
      : 0;

  return json({
    quota: quota || null,
    usage: {
      applications: teamApps.length,
      containers: containerCount,
    },
  });
});

/** POST: Set/update quota. Admin only. */
export const POST: RequestHandler = route(async (event) => {
  requireAdminUser(event);
  const teamId = event.params.id!;

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return json({ error: 'Team not found' }, { status: 404 });

  const body = await event.request.json();
  const { maxCpuCores, maxMemoryBytes, maxContainers, maxApplications } = body;

  const now = new Date();
  const existing = await db.select().from(teamQuotas).where(eq(teamQuotas.teamId, teamId)).get();

  if (existing) {
    await db.update(teamQuotas).set({
      maxCpuCores: maxCpuCores !== undefined ? maxCpuCores : existing.maxCpuCores,
      maxMemoryBytes: maxMemoryBytes !== undefined ? maxMemoryBytes : existing.maxMemoryBytes,
      maxContainers: maxContainers !== undefined ? maxContainers : existing.maxContainers,
      maxApplications: maxApplications !== undefined ? maxApplications : existing.maxApplications,
      updatedAt: now,
    }).where(eq(teamQuotas.id, existing.id));
  } else {
    await db.insert(teamQuotas).values({
      id: crypto.randomUUID(),
      teamId,
      maxCpuCores: maxCpuCores ?? null,
      maxMemoryBytes: maxMemoryBytes ?? null,
      maxContainers: maxContainers ?? null,
      maxApplications: maxApplications ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return json({ success: true });
});
