import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import { appStorage } from '$lib/server/app-volumes';

/**
 * Every volume this application uses, whatever it was deployed from.
 *
 * Read-only against the worker: `listVolumes` and `system/df`, and no path from
 * here to a create, remove or start. The volume registry only ever covered
 * single-container applications, so this is the first view that answers the
 * question for a compose file or a Kubernetes manifest too — see
 * `appStorage`, which reads it out of the same intent a deploy acts on.
 */
export const GET: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);

  const worker = application.workerId
    ? await db.select().from(workers).where(eq(workers.id, application.workerId)).get()
    : null;

  return json(await appStorage(application, worker ?? null));
});
