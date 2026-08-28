import { redirect, error } from '@sveltejs/kit';
import { db, safeWorkerColumns } from '$lib/db';
import { applications, workers, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { canAccessApplication, requireAuth } from '$lib/server/auth';
import { driftForApplication } from '$lib/server/reconcile';
import { primaryUrl, routeUrls, serviceUrls, unroutedPorts } from '$lib/server/app-urls';

export const load = async ({ params, cookies }: { params: { id: string }; cookies: any }) => {
  const ctx = await requireAuth(cookies);

  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    throw error(404, 'Application not found');
  }

  const { application } = access;

  const worker = application.workerId
    ? await db.select(safeWorkerColumns).from(workers).where(eq(workers.id, application.workerId)).get()
    : null;

  const appContainers = await db
    .select()
    .from(containers)
    .where(eq(containers.applicationId, params.id))
    .all();

  const appUrl = primaryUrl(application.domain, appContainers);
  const urls = serviceUrls(appContainers);

  // Every port the application answers on, with whether the login flow covers
  // it. Built from the active containers only: a draining generation still has
  // rows, and listing its ports would show URLs that stop working without
  // notice. Deduplicated by URL, since replicas share one.
  const byUrl = new Map<string, ReturnType<typeof routeUrls>[number]>();
  const oidcEnabled =
    application.authType === 'oidc' || (application.authType === 'global' && !!worker?.oidcEnabled);
  for (const row of appContainers) {
    if (row.state !== 'active') continue;
    for (const route of routeUrls(row, oidcEnabled)) {
      if (!byUrl.has(route.url)) byUrl.set(route.url, route);
    }
  }
  const portUrls = [...byUrl.values()].sort((a, b) => a.publicPort - b.publicPort);

  // From the last reconciliation pass, not computed here: the page must not make
  // a Podman call per view, and the timer's answer is at most one cycle old.
  const drift = await driftForApplication(params.id);

  return {
    user: ctx.user,
    application,
    worker,
    containers: appContainers,
    appUrl,
    serviceUrls: urls,
    portUrls,
    /** Ports declared public that produced no route, and why. */
    unroutedPorts: unroutedPorts(application, appContainers),
    drift,
  };
};
