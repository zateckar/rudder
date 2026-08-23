import { db, safeWorkerColumns, safeApplicationColumns } from '$lib/db';
import { applications, workers, teams, teamMembers, containers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { primaryUrl, serviceUrls } from '$lib/server/app-urls';
import { requirePageUser } from '$lib/server/auth';

function getAppStatus(appContainers: (typeof containers.$inferSelect)[]): { label: string; color: string } {
  if (appContainers.length === 0) return { label: 'not deployed', color: 'gray' };

  const running = appContainers.filter(c => c.status === 'running').length;
  if (running === appContainers.length) return { label: 'running', color: 'green' };
  if (running === 0) return { label: 'stopped', color: 'red' };
  return { label: 'partial', color: 'orange' };
}

export const load = async (event: { url: URL; locals: App.Locals }) => {
  const currentUser = requirePageUser(event).user;
  const userId = currentUser.id;

  let userApps: any[] = [];
  const urlTeam = event.url.searchParams.get('team');

  if (currentUser.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    userApps = await db.select(safeApplicationColumns).from(applications).all();
  } else {
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const teamIds = memberships.map(m => m.teamId);
    
    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = (currentUser?.role === 'admin' || teamIds.includes(urlTeam)) ? [urlTeam] : [];
    }
    
    if (targetTeamIds.length > 0) {
      userApps = await db
        .select(safeApplicationColumns)
        .from(applications)
        .where(inArray(applications.teamId, targetTeamIds))
        .all();
    } else {
      userApps = [];
    }
  }

  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();
  const allTeams = await db.select().from(teams).all();

  // Load all containers for these applications
  const appIds = userApps.map(a => a.id);
  const allContainers = appIds.length > 0
    ? await db.select().from(containers).where(inArray(containers.applicationId, appIds)).all()
    : [];

  // Enrich each application with URL and status
  const enrichedApps = userApps.map(app => {
    const appContainers = allContainers.filter(c => c.applicationId === app.id);
    return {
      ...app,
      appUrl: primaryUrl(app.domain, appContainers),
      serviceUrls: app.type === 'compose' ? serviceUrls(appContainers) : [],
      status: getAppStatus(appContainers),
    };
  });

  return {
    user: currentUser,
    applications: enrichedApps,
    workers: allWorkers,
    teams: allTeams,
  };
};
