import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers, applications, containers, teams, users, auditLogs, deployments } from '$lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { getAllWorkerResources } from '$lib/server/worker-selector';

export const load = async ({ url, cookies }: { url: URL; cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  
  if (!sessionId) {
    throw redirect(303, '/login');
  }
  
  const userId = await validateSession(sessionId);
  
  if (!userId) {
    throw redirect(303, '/login');
  }

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  
  // Filter by team if requested
  const urlTeam = url.searchParams.get('team');
  let targetTeamIds: string[] = [];
  
  if (currentUser?.role === 'admin') {
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = [urlTeam];
    } else {
      const allTeams = await db.select({ id: teams.id }).from(teams).all();
      targetTeamIds = allTeams.map(t => t.id);
    }
  } else {
    const { teamMembers } = await import('$lib/db/schema');
    const { inArray } = await import('drizzle-orm');
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const userTeamIds = memberships.map(m => m.teamId);
    
    if (urlTeam && urlTeam !== 'all' && userTeamIds.includes(urlTeam)) {
      targetTeamIds = [urlTeam];
    } else {
      targetTeamIds = userTeamIds;
    }
  }

  const allWorkers = await db.select().from(workers).all();
  
  let allApplications: any[] = [];
  let allContainers: any[] = [];
  let allTeams: any[] = [];

  if (targetTeamIds.length > 0) {
    const { inArray } = await import('drizzle-orm');
    allApplications = await db.select().from(applications).where(inArray(applications.teamId, targetTeamIds)).all();
    allTeams = await db.select().from(teams).where(inArray(teams.id, targetTeamIds)).all();
    // Simplified: Just get all containers for now, a proper implementation would filter containers by application teamId
    allContainers = await db.select().from(containers).all();
  } else if (currentUser?.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    allApplications = await db.select().from(applications).all();
    allContainers = await db.select().from(containers).all();
    allTeams = await db.select().from(teams).all();
  }

  // Worker resource info for admin dashboard
  let workerResources: Awaited<ReturnType<typeof getAllWorkerResources>> = [];
  if (currentUser?.role === 'admin') {
    try {
      workerResources = await getAllWorkerResources();
    } catch {}
  }

  // Recent activity: last 10 audit log entries with user info
  const recentActivity = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      details: auditLogs.details,
      createdAt: auditLogs.createdAt,
      userId: auditLogs.userId,
      username: users.username,
      fullName: users.fullName,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(10)
    .all();

  // Container status breakdown: count containers grouped by status
  const containerStatusRows = await db
    .select({
      status: containers.status,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(containers)
    .groupBy(containers.status)
    .all();

  const containerStatusBreakdown: Record<string, number> = {};
  for (const row of containerStatusRows) {
    containerStatusBreakdown[row.status] = row.count;
  }

  // Recent deployments: last 5 with app name
  const recentDeployments = await db
    .select({
      id: deployments.id,
      applicationId: deployments.applicationId,
      version: deployments.version,
      status: deployments.status,
      createdAt: deployments.createdAt,
      finishedAt: deployments.finishedAt,
      appName: applications.name,
    })
    .from(deployments)
    .leftJoin(applications, eq(deployments.applicationId, applications.id))
    .orderBy(desc(deployments.createdAt))
    .limit(5)
    .all();

  return {
    user: currentUser,
    workers: allWorkers,
    applications: allApplications,
    containers: allContainers,
    teams: allTeams,
    workerResources,
    recentActivity,
    containerStatusBreakdown,
    recentDeployments,
  };
};
