import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { encryptField } from '$lib/server/encryption';
import { generateOidcSecret, isValidOidcSecret, oidcCallbackUrl, oidcCallbackHost } from '$lib/server/oidc';

/** Shape returned to the settings UI. Never includes secret material. */
function publicOidcState(worker: typeof workers.$inferSelect) {
  return {
    oidcEnabled: worker.oidcEnabled,
    oidcProviderUrl: worker.oidcProviderUrl,
    oidcClientId: worker.oidcClientId,
    oidcClientSecretSet: !!worker.oidcClientSecret,
    oidcEncryptionKeySet: !!worker.oidcEncryptionKey,
    oidcAppliedAt: worker.oidcAppliedAt,
    // The single redirect URI to register with the identity provider, and the
    // hostname that needs a DNS A record pointing at this worker.
    callbackUrl: worker.baseDomain ? oidcCallbackUrl(worker.baseDomain) : null,
    callbackHost: worker.baseDomain ? oidcCallbackHost(worker.baseDomain) : null,
  };
}

/** GET /api/workers/[id]/oidc — return current OIDC config (secret masked) */
export const GET: RequestHandler = async ({ params, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });
  if (locals.userRole !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  return json(publicOidcState(worker));
};

/** PUT /api/workers/[id]/oidc — save OIDC config */
export const PUT: RequestHandler = async ({ params, request, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });
  if (locals.userRole !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const body = await request.json();
  const { oidcEnabled, oidcProviderUrl, oidcClientId, oidcClientSecret, oidcEncryptionKey } = body;

  if (oidcEnabled && (!oidcProviderUrl || !oidcClientId)) {
    return json({ error: 'Provider URL and Client ID are required when OIDC is enabled' }, { status: 400 });
  }

  if (oidcEnabled && !worker.baseDomain) {
    return json({
      error: 'This worker has no base domain. OIDC needs one to build the shared callback URL.',
    }, { status: 400 });
  }

  const updates: Record<string, any> = {
    oidcEnabled: !!oidcEnabled,
    oidcProviderUrl: oidcProviderUrl || null,
    oidcClientId: oidcClientId || null,
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

  await db.update(workers).set(updates).where(eq(workers.id, params.id));
  const updated = await db.select().from(workers).where(eq(workers.id, params.id)).get();

  return json(publicOidcState(updated!));
};

/** DELETE /api/workers/[id]/oidc — clear all OIDC config */
export const DELETE: RequestHandler = async ({ params, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });
  if (locals.userRole !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  await db.update(workers).set({
    oidcEnabled: false,
    oidcProviderUrl: null,
    oidcClientId: null,
    oidcClientSecret: null,
    oidcEncryptionKey: null,
    oidcAppliedAt: null,
  }).where(eq(workers.id, params.id));

  return json({ success: true });
};
