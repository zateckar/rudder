import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { encryptField } from '$lib/server/encryption';
import {
  CALLBACK_PATH_INVALID,
  generateOidcSecret,
  isValidCallbackPath,
  isValidOidcSecret,
  normalizeIssuerUrl,
  oidcCallbackHost,
  oidcCallbackUrl,
  resolveCallbackPath,
} from '$lib/server/oidc';
import { requireWorker, route } from '$lib/server/auth';

/** Shape returned to the settings UI. Never includes secret material. */
function publicOidcState(worker: typeof workers.$inferSelect) {
  return {
    oidcEnabled: worker.oidcEnabled,
    oidcProviderUrl: worker.oidcProviderUrl,
    oidcClientId: worker.oidcClientId,
    oidcClientSecretSet: !!worker.oidcClientSecret,
    oidcEncryptionKeySet: !!worker.oidcEncryptionKey,
    oidcAppliedAt: worker.oidcAppliedAt,
    // Resolved rather than raw, so the form shows the path actually in force
    // instead of an empty box meaning "the default, whatever that is".
    oidcCallbackPath: resolveCallbackPath(worker.oidcCallbackPath),
    // The single redirect URI to register with the identity provider, and the
    // hostname that needs a DNS A record pointing at this worker.
    callbackUrl: worker.baseDomain
      ? oidcCallbackUrl(worker.baseDomain, worker.oidcCallbackPath)
      : null,
    callbackHost: worker.baseDomain ? oidcCallbackHost(worker.baseDomain) : null,
  };
}

/** GET /api/workers/[id]/oidc — return current OIDC config (secret masked) */
export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);
  return json(publicOidcState(worker));
});

/** PUT /api/workers/[id]/oidc — save OIDC config */
export const PUT: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  const { worker } = await requireWorker(event, workerId);

  const body = await event.request.json();
  const {
    oidcEnabled,
    oidcProviderUrl,
    oidcClientId,
    oidcClientSecret,
    oidcEncryptionKey,
    oidcCallbackPath,
  } = body;

  if (oidcEnabled && (!oidcProviderUrl || !oidcClientId)) {
    return json({ error: 'Provider URL and Client ID are required when OIDC is enabled' }, { status: 400 });
  }

  if (oidcEnabled && !worker.baseDomain) {
    return json({
      error: 'This worker has no base domain. OIDC needs one to build the shared callback URL.',
    }, { status: 400 });
  }

  // Silently storing an unusable path would be worse than refusing it: the
  // config applies cleanly and only fails at the identity provider, one
  // redirect into a user's login.
  if (oidcCallbackPath !== undefined && oidcCallbackPath !== null && oidcCallbackPath !== '') {
    if (typeof oidcCallbackPath !== 'string' || !isValidCallbackPath(oidcCallbackPath)) {
      return json({ error: CALLBACK_PATH_INVALID }, { status: 400 });
    }
  }

  const updates: Record<string, any> = {
    oidcEnabled: !!oidcEnabled,
    // Stored as the issuer. A pasted discovery URL is corrected rather than
    // refused — it is unambiguous what was meant — and the response carries the
    // stored value back so the form shows what was actually saved.
    oidcProviderUrl: normalizeIssuerUrl(oidcProviderUrl),
    oidcClientId: oidcClientId || null,
    // Blank clears it back to the default rather than storing an empty path.
    oidcCallbackPath: oidcCallbackPath || null,
    // Any change invalidates what is currently deployed on the worker, so the
    // operator has to push it again before deploys will attach the middleware.
    oidcAppliedAt: null,
  };

  // Only update secret if a new one is provided (empty string = keep existing)
  if (oidcClientSecret !== undefined && oidcClientSecret !== '') {
    updates.oidcClientSecret = encryptField(oidcClientSecret);
  }

  // The plugin uses this value directly as an AES-256 key: anything other than
  // exactly 32 characters makes the middleware fail to build, which makes
  // Traefik discard the entire dynamic config file.
  if (oidcEncryptionKey) {
    if (!isValidOidcSecret(oidcEncryptionKey)) {
      return json({
        error: 'Session encryption key must be exactly 32 characters. Leave it blank to have one generated.',
      }, { status: 400 });
    }
    updates.oidcEncryptionKey = encryptField(oidcEncryptionKey);
  } else if (oidcEnabled && !worker.oidcEncryptionKey) {
    updates.oidcEncryptionKey = encryptField(generateOidcSecret());
  }

  await db.update(workers).set(updates).where(eq(workers.id, workerId));
  const updated = await db.select().from(workers).where(eq(workers.id, workerId)).get();

  return json(publicOidcState(updated!));
});

/** DELETE /api/workers/[id]/oidc — clear all OIDC config */
export const DELETE: RequestHandler = route(async (event) => {
  const workerId = event.params.id!;
  await requireWorker(event, workerId);

  await db.update(workers).set({
    oidcEnabled: false,
    oidcProviderUrl: null,
    oidcClientId: null,
    oidcClientSecret: null,
    oidcEncryptionKey: null,
    oidcCallbackPath: null,
    oidcAppliedAt: null,
  }).where(eq(workers.id, workerId));

  return json({ success: true });
});
