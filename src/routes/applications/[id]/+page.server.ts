import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { canAccessApplication, requireAuth } from '$lib/server/auth';

/** Extract per-service URLs from compose container labels (deduplicated by URL). */
function extractServiceUrls(appContainers: typeof containers.$inferSelect[]): Array<{ name: string; url: string }> {
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
      // ignore malformed JSON
    }
  }
  return Array.from(urlMap.values());
}

/** Extract the primary app URL: explicit domain first, then first container Traefik label. */
function extractAppUrl(appName: string, appDomain: string | null | undefined, appContainers: typeof containers.$inferSelect[]): string | null {
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

export const load = async ({ params, cookies }: { params: { id: string }; cookies: any }) => {
  const ctx = await requireAuth(cookies);

  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    throw error(404, 'Application not found');
  }

  const { application } = access;

  const worker = application.workerId
    ? await db.select().from(workers).where(eq(workers.id, application.workerId)).get()
    : null;

  const appContainers = await db
    .select()
    .from(containers)
    .where(eq(containers.applicationId, params.id))
    .all();

  const appUrl = extractAppUrl(application.name, application.domain, appContainers);
  const serviceUrls = extractServiceUrls(appContainers);

  return {
    user: ctx.user,
    application,
    worker,
    containers: appContainers,
    appUrl,
    serviceUrls,
  };
};
