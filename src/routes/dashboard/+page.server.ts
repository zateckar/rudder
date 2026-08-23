import { db, safeWorkerColumns, safeApplicationColumns } from '$lib/db';
import { workers, applications, containers, teams, users, auditLogs, deployments, teamMembers } from '$lib/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { getAllWorkerResources } from '$lib/server/worker-selector';
import { requirePageUser } from '$lib/server/auth';

export const load = async (event: { url: URL; locals: App.Locals }) => {
  const currentUser = requirePageUser(event).user;
  const userId = currentUser.id;
  const { url } = event;

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
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const userTeamIds = memberships.map(m => m.teamId);
    
    if (urlTeam && urlTeam !== 'all' && userTeamIds.includes(urlTeam)) {
      targetTeamIds = [urlTeam];
    } else {
      targetTeamIds = userTeamIds;
    }
  }

  /**
   * An admin looking at every team sees the whole installation. Everyone else —
   * including an admin who has picked one team — sees only what that scope owns.
   * Every query below is filtered by this, because the dashboard is the one page
   * a member always lands on and it used to answer questions about other teams.
   */
  const scopeIsGlobal = currentUser?.role === 'admin' && (!urlTeam || urlTeam === 'all');

  let allApplications: any[] = [];
  let allContainers: any[] = [];
  let allTeams: any[] = [];

  if (scopeIsGlobal) {
    allApplications = await db.select(safeApplicationColumns).from(applications).all();
    allContainers = await db.select().from(containers).all();
    allTeams = await db.select().from(teams).all();
  } else if (targetTeamIds.length > 0) {
    allApplications = await db
      .select(safeApplicationColumns)
      .from(applications)
      .where(inArray(applications.teamId, targetTeamIds))
      .all();
    allTeams = await db.select().from(teams).where(inArray(teams.id, targetTeamIds)).all();
    const appIds = allApplications.map((a) => a.id);
    allContainers = appIds.length > 0
      ? await db.select().from(containers).where(inArray(containers.applicationId, appIds)).all()
      : [];
  }

  // Workers are an admin concept — the /workers pages are admin-only. A member
  // sees only the ones actually running their applications.
  const workerRows = await db.select(safeWorkerColumns).from(workers).all();
  const allWorkers = scopeIsGlobal
    ? workerRows
    : workerRows.filter((w) => allApplications.some((a) => a.workerId === w.id));

  // Worker resource info for admin dashboard
  let workerResources: Awaited<ReturnType<typeof getAllWorkerResources>> = [];
  if (currentUser?.role === 'admin') {
    try {
      workerResources = await getAllWorkerResources();
    } catch (e) {
      // Logged, not swallowed. An empty list here renders as "No metrics —
      // worker may be offline or metrics not yet collected" against every
      // worker on the installation, which reads as a fleet-wide outage and says
      // nothing about the query that actually failed.
      console.error('[dashboard] Could not load worker resources:', (e as any)?.message || e);
    }
  }

  // Recent activity: last 10 audit log entries with user info.
  // Entries with no team are installation-wide (users, API keys, workers) and
  // stay admin-only; a member sees their own teams' history and nothing else.
  const activityColumns = {
    id: auditLogs.id,
    action: auditLogs.action,
    resourceType: auditLogs.resourceType,
    resourceId: auditLogs.resourceId,
    details: auditLogs.details,
    createdAt: auditLogs.createdAt,
    userId: auditLogs.userId,
    username: users.username,
    fullName: users.fullName,
  };

  let recentActivity: any[] = [];
  if (scopeIsGlobal) {
    recentActivity = await db
      .select(activityColumns)
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10)
      .all();
  } else if (targetTeamIds.length > 0) {
    recentActivity = await db
      .select(activityColumns)
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(inArray(auditLogs.teamId, targetTeamIds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10)
      .all();
  }

  // Container status breakdown, counted from the containers already in scope
  // rather than from a global GROUP BY.
  const containerStatusBreakdown: Record<string, number> = {};
  for (const c of allContainers) {
    containerStatusBreakdown[c.status] = (containerStatusBreakdown[c.status] ?? 0) + 1;
  }

  // Recent deployments: last 5 with app name
  const deploymentColumns = {
    id: deployments.id,
    applicationId: deployments.applicationId,
    version: deployments.version,
    status: deployments.status,
    createdAt: deployments.createdAt,
    finishedAt: deployments.finishedAt,
    appName: applications.name,
  };

  let recentDeployments: any[] = [];
  if (scopeIsGlobal) {
    recentDeployments = await db
      .select(deploymentColumns)
      .from(deployments)
      .leftJoin(applications, eq(deployments.applicationId, applications.id))
      .orderBy(desc(deployments.createdAt))
      .limit(5)
      .all();
  } else if (targetTeamIds.length > 0) {
    recentDeployments = await db
      .select(deploymentColumns)
      .from(deployments)
      .innerJoin(applications, eq(deployments.applicationId, applications.id))
      .where(inArray(applications.teamId, targetTeamIds))
      .orderBy(desc(deployments.createdAt))
      .limit(5)
      .all();
  }

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
