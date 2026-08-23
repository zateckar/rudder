import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { encryptField } from '$lib/server/encryption';
import { requireWorker, route } from '$lib/server/auth';

/**
 * HTTP Basic credentials the worker presents to whatever sits in front of the
 * control plane.
 *
 * Rudder does not ask for these — a proxy does. Where one is deployed, it
 * answers the worker's routing fetch with 401 before Rudder ever sees the
 * request, so the per-worker bearer token can never be checked and no amount of
 * re-provisioning helps. Configuring them here lets the worker satisfy the outer
 * layer; its own token then travels in `X-Rudder-Config-Token`.
 *
 * The alternative — exempting the routing endpoint at the proxy — is still the
 * better answer where it is available, because it keeps one credential in play
 * instead of two. This is for deployments where that is not the operator's to
 * change.
 */

/** Shape returned to the settings UI. Never includes the password. */
function publicState(worker: typeof workers.$inferSelect) {
  return {
    configBasicUser: worker.configBasicUser,
    configBasicPasswordSet: !!worker.configBasicPassword,
  };
}

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);
  return json(publicState(worker));
});

/** PUT — set or update the credentials. */
export const PUT: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);

  const body = await event.request.json().catch(() => ({}));
  const username = typeof body?.configBasicUser === 'string' ? body.configBasicUser.trim() : '';
  const password = typeof body?.configBasicPassword === 'string' ? body.configBasicPassword : '';

  if (!username) {
    return json(
      { error: 'A username is required. Use DELETE to remove the credentials entirely.' },
      { status: 400 },
    );
  }

  // A username with no password, on a worker that has none stored, would be
  // written to the worker and then fail every fetch with the same 401 it was
  // meant to fix — while looking configured in the UI.
  if (!password && !worker.configBasicPassword) {
    return json(
      { error: 'A password is required the first time these credentials are set.' },
      { status: 400 },
    );
  }

  // Neither may contain a colon-splitting or header-breaking character: the pair
  // is written to a curl config file on the worker and sent as one header.
  // Newlines would let a value inject a second directive.
  if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) {
    return json({ error: 'Credentials must not contain line breaks.' }, { status: 400 });
  }
  if (username.includes(':')) {
    return json(
      { error: 'The username must not contain a colon — HTTP Basic uses it to separate the two halves.' },
      { status: 400 },
    );
  }

  await db
    .update(workers)
    .set({
      configBasicUser: username,
      // Blank keeps the stored password, matching how the OIDC client secret
      // behaves: the form cannot show it, so it cannot resubmit it either.
      ...(password ? { configBasicPassword: encryptField(password) } : {}),
    })
    .where(eq(workers.id, workerId));

  const updated = await db.select().from(workers).where(eq(workers.id, workerId)).get();

  return json({
    ...publicState(updated!),
    message:
      'Saved. Re-provision the worker to deliver the credentials — they are written to its ' +
      'configuration file, which only provisioning updates.',
  });
});

/** DELETE — remove them, for a control plane that stops requiring them. */
export const DELETE: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  await requireWorker(event, workerId);

  await db
    .update(workers)
    .set({ configBasicUser: null, configBasicPassword: null })
    .where(eq(workers.id, workerId));

  return json({
    configBasicUser: null,
    configBasicPasswordSet: false,
    message:
      'Removed. Re-provision the worker to clear them from its configuration file — until then it keeps ' +
      'presenting the old credentials.',
  });
});
