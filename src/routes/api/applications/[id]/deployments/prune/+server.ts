import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApplication, route } from '$lib/server/auth';
import { pruneDeployments } from '$lib/server/deployment-prune';
import { ValidationError } from '$lib/server/validation';

function parseKeep(raw: unknown): number {
  const keep = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new ValidationError('"keep" must be a whole number of deployments, at least 1.');
  }
  return keep;
}

/**
 * What pruning to the newest `?keep=N` deployments would remove — the history
 * rows, and the images on the worker only they used. Changes nothing.
 *
 * Asked before the confirmation, so the dialog can say what is about to go
 * rather than describe the rule that will pick it.
 */
export const GET: RequestHandler = route(async (event) => {
  const { ctx, application } = await requireApplication(event, event.params.id!);
  const keep = parseKeep(event.url.searchParams.get('keep'));
  return json(await pruneDeployments(application, keep, { dryRun: true, userId: ctx.user.id }));
});

/**
 * Prune to the newest `keep` deployments. Same scope as the history itself: the
 * owning team. Recomputed under the worker's deploy lock rather than trusting
 * the preview, which may be minutes old.
 */
export const POST: RequestHandler = route(async (event) => {
  const { ctx, application } = await requireApplication(event, event.params.id!);
  const body = await event.request.json().catch(() => ({}));
  const keep = parseKeep(body?.keep);
  return json(await pruneDeployments(application, keep, { dryRun: false, userId: ctx.user.id }));
});
