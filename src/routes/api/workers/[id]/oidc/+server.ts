import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { encryptField } from '$lib/server/encryption';

/** GET /api/workers/[id]/oidc — return current OIDC config (secret masked) */
export const GET: RequestHandler = async ({ params, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });
  if (locals.userRole !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  return json({
    oidcEnabled: worker.oidcEnabled,
    oidcProviderUrl: worker.oidcProviderUrl,
    oidcClientId: worker.oidcClientId,
    oidcClientSecretSet: !!worker.oidcClientSecret,
    oidcEncryptionKeySet: !!worker.oidcEncryptionKey,
  });
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

  const updates: Record<string, any> = {
    oidcEnabled: !!oidcEnabled,
    oidcProviderUrl: oidcProviderUrl || null,
    oidcClientId: oidcClientId || null,
  };

  // Only update secret if a new one is provided (empty string = keep existing)
  if (oidcClientSecret !== undefined && oidcClientSecret !== '') {
    updates.oidcClientSecret = encryptField(oidcClientSecret);
  }

  // Update encryption key if provided; auto-generate if enabling and none exists
  if (oidcEncryptionKey) {
    updates.oidcEncryptionKey = encryptField(oidcEncryptionKey);
  } else if (oidcEnabled && !worker.oidcEncryptionKey) {
    updates.oidcEncryptionKey = encryptField(randomBytes(32).toString('hex'));
  }

  await db.update(workers).set(updates).where(eq(workers.id, params.id));
  const updated = await db.select().from(workers).where(eq(workers.id, params.id)).get();

  return json({
    oidcEnabled: updated?.oidcEnabled,
    oidcProviderUrl: updated?.oidcProviderUrl,
    oidcClientId: updated?.oidcClientId,
    oidcClientSecretSet: !!updated?.oidcClientSecret,
    oidcEncryptionKeySet: !!updated?.oidcEncryptionKey,
  });
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
  }).where(eq(workers.id, params.id));

  return json({ success: true });
};
