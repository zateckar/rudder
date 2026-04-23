import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, users, workers, teams, teamMembers, containers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

/** Extract the primary app URL: first traefik router rule from any container. */
function extractAppUrl(appName: string, appDomain: string | null | undefined, appContainers: (typeof containers.$inferSelect)[]): string | null {
  if (appDomain) return `https://${appDomain}`;

  for (const c of appContainers) {
    if (!c.labels) continue;
    try {
      const labels: Record<string, string> = JSON.parse(c.labels);
      for (const [key, value] of Object.entries(labels)) {
        if (key.startsWith('traefik.http.routers.') && key.endsWith('.rule')) {
          const match = (value as string).match(/Host\(`([^`]+)`\)/);
          if (match) return `https://${match[1]}`;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** Extract per-service URLs from container labels (deduplicated by URL). */
function extractServiceUrls(appContainers: (typeof containers.$inferSelect)[]): Array<{ name: string; url: string }> {
  const urlMap = new Map<string, { name: string; url: string }>();
  for (const c of appContainers) {
    if (!c.labels) continue;
    try {
      const labels: Record<string, string> = JSON.parse(c.labels);
      for (const [key, value] of Object.entries(labels)) {
        if (key.startsWith('traefik.http.routers.') && key.endsWith('.rule')) {
          const match = (value as string).match(/Host\(`([^`]+)`\)/);
          if (match) {
            const url = `https://${match[1]}`;
            if (!urlMap.has(url)) {
              const routerName = key.replace('traefik.http.routers.', '').replace('.rule', '');
              urlMap.set(url, { name: routerName, url });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(urlMap.values());
}

function getAppStatus(appContainers: (typeof containers.$inferSelect)[]): { label: string; color: string } {
  if (appContainers.length === 0) return { label: 'not deployed', color: 'gray' };

  const running = appContainers.filter(c => c.status === 'running').length;
  if (running === appContainers.length) return { label: 'running', color: 'green' };
  if (running === 0) return { label: 'stopped', color: 'red' };
  return { label: 'partial', color: 'orange' };
}

export const load = async ({ url, cookies }: { url: URL; cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');
  
  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  
  let userApps: any[] = [];
  const urlTeam = url.searchParams.get('team');

  if (currentUser?.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    userApps = await db.select().from(applications).all();
  } else {
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const teamIds = memberships.map(m => m.teamId);
    
    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      if (currentUser?.role === 'admin' || teamIds.includes(urlTeam)) {
        targetTeamIds = [urlTeam];
      }
    }
    
    if (targetTeamIds.length > 0) {
      userApps = await db.select().from(applications).where(inArray(applications.teamId, targetTeamIds)).all();
    } else {
      userApps = [];
    }
  }

  const allWorkers = await db.select().from(workers).all();
  const allTeams = await db.select().from(teams).all();

  // Load all containers for these applications
  const appIds = userApps.map(a => a.id);
  const allContainers = appIds.length > 0
    ? await db.select().from(containers).where(inArray(containers.applicationId, appIds)).all()
    : [];

  // Enrich each application with URL and status
  const enrichedApps = userApps.map(app => {
    const appContainers = allContainers.filter(c => c.applicationId === app.id);
    const appUrl = extractAppUrl(app.name, app.domain, appContainers);
    const serviceUrls = app.type === 'compose' ? extractServiceUrls(appContainers) : [];
    const status = getAppStatus(appContainers);
    return { ...app, appUrl, serviceUrls, status };
  });

  return {
    user: currentUser,
    applications: enrichedApps,
    workers: allWorkers,
    teams: allTeams,
  };
};
