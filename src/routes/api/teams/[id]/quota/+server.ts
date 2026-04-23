import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { teamQuotas, teams, users, applications, containers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

/** GET: Return quota for this team + current usage */
export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const team = await db.select().from(teams).where(eq(teams.id, params.id)).get();
  if (!team) return json({ error: 'Team not found' }, { status: 404 });

  const quota = await db.select().from(teamQuotas).where(eq(teamQuotas.teamId, params.id)).get();

  // Count current usage
  const teamApps = await db.select().from(applications).where(eq(applications.teamId, params.id)).all();
  const appIds = teamApps.map(a => a.id);

  let containerCount = 0;
  if (appIds.length > 0) {
    for (const appId of appIds) {
      const appContainers = await db.select().from(containers).where(eq(containers.applicationId, appId)).all();
      containerCount += appContainers.length;
    }
  }

  return json({
    quota: quota || null,
    usage: {
      applications: teamApps.length,
      containers: containerCount,
    },
  });
}

/** POST: Set/update quota. Admin only. */
export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const team = await db.select().from(teams).where(eq(teams.id, params.id)).get();
  if (!team) return json({ error: 'Team not found' }, { status: 404 });

  const body = await request.json();
  const { maxCpuCores, maxMemoryBytes, maxContainers, maxApplications } = body;

  const now = new Date();
  const existing = await db.select().from(teamQuotas).where(eq(teamQuotas.teamId, params.id)).get();

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
      id: uuid(),
      teamId: params.id,
      maxCpuCores: maxCpuCores ?? null,
      maxMemoryBytes: maxMemoryBytes ?? null,
      maxContainers: maxContainers ?? null,
      maxApplications: maxApplications ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return json({ success: true });
}
