import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { apiKeys, users, teamMembers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { hashKey } from '$lib/server/encryption';
import { randomBytes } from 'crypto';

/** Generate a cryptographically secure API key with a recognisable prefix. */
function generateApiKey(): string {
  return 'rud_' + randomBytes(24).toString('base64url');
}

export async function GET({ cookies }: { cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).get();

  const keys = await db.select().from(apiKeys).all();

  const filteredKeys = user?.role === 'admin'
    ? keys
    : keys.filter(k => k.teamId === null);

  return json(filteredKeys.map(k => ({
    ...k,
    keyPrefix: k.name ? `sk_${k.name.substring(0, 8)}` : null,
  })));
}

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { name, teamId, expiresInDays } = body;

  if (!name) {
    return json({ error: 'API key name is required' }, { status: 400 });
  }

  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const keyId = uuid();

  await db.insert(apiKeys).values({
    id: keyId,
    name,
    keyHash,
    teamId: teamId || null,
    expiresAt,
    createdAt: new Date(),
  });

  return json({
    id: keyId,
    name,
    key: rawKey,
    expiresAt,
  });
}

export async function DELETE({ url, cookies }: { url: URL; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyId = url.searchParams.get('id');
  if (!keyId) {
    return json({ error: 'API key ID required' }, { status: 400 });
  }

  // Fetch the key to check ownership before deleting.
  const key = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key) {
    return json({ error: 'API key not found' }, { status: 404 });
  }

  // Admins may delete any key.
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.role === 'admin') {
    await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
    return json({ success: true });
  }

  // Non-admins may only delete keys that belong to a team they are a member of.
  if (!key.teamId) {
    // Global (non-team) keys may only be deleted by admins.
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, key.teamId), eq(teamMembers.userId, userId)))
    .get();

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return json({ success: true });
}
