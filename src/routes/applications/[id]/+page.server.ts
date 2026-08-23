import { redirect, error } from '@sveltejs/kit';
import { db, safeWorkerColumns } from '$lib/db';
import { applications, workers, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { canAccessApplication, requireAuth } from '$lib/server/auth';
import { driftForApplication } from '$lib/server/reconcile';
import { primaryUrl, serviceUrls } from '$lib/server/app-urls';

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
    drift,
  };
};
