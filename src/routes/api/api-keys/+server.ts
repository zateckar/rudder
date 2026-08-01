import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { apiKeys, teamMembers } from '$lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { hashKey } from '$lib/server/encryption';
import { randomBytes } from 'crypto';
import {
  authErrorResponse,
  requireAuth,
  requireTeamOwner,
  type AuthContext,
} from '$lib/server/auth';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';

/** Generate a cryptographically secure API key with a recognisable prefix. */
function generateApiKey(): string {
  return 'rud_' + randomBytes(24).toString('base64url');
}

/** Strip the key hash before returning a row to the client. */
function publicKey(row: typeof apiKeys.$inferSelect) {
  const { keyHash: _hash, ...rest } = row;
  return { ...rest, scope: row.teamId ? 'team' : 'global' };
}

export async function GET({ cookies }: { cookies: any }) {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  // Admins see every key.  Everyone else sees only keys scoped to a team they
  // belong to — global keys carry cross-team access and are admin-only.
  if (ctx.user.role === 'admin') {
    const keys = await db.select().from(apiKeys).all();
    return json(keys.map(publicKey));
  }

  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, ctx.user.id))
    .all();

  const teamIds = memberships.map((m) => m.teamId);
  if (teamIds.length === 0) return json([]);

  const keys = await db
    .select()
    .from(apiKeys)
    .where(inArray(apiKeys.teamId, teamIds))
    .all();

  return json(keys.map(publicKey));
}

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  let body;
  try {
    body = await parseJsonBody(request, schemas.createApiKey);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { name, teamId, expiresInDays } = body;

  // A key with no teamId is global: it grants access to every team through the
  // Kubernetes-compatible API, so only admins may mint one.  Team-scoped keys
  // require ownership of that specific team.
  if (!teamId) {
    if (ctx.user.role !== 'admin') {
      return json(
        { error: 'Only admins can create global API keys. Specify a teamId for a team-scoped key.' },
        { status: 403 },
      );
    }
  } else {
    try {
      await requireTeamOwner(cookies, teamId);
    } catch (error) {
      return authErrorResponse(error);
    }
  }

  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const keyId = crypto.randomUUID();

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
    scope: teamId ? 'team' : 'global',
    teamId: teamId || null,
    // The only time the raw key is ever returned.
    key: rawKey,
    expiresAt,
  });
}

export async function DELETE({ url, cookies }: { url: URL; cookies: any }) {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  const keyId = url.searchParams.get('id');
  if (!keyId) {
    return json({ error: 'API key ID required' }, { status: 400 });
  }

  const key = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key) {
    return json({ error: 'API key not found' }, { status: 404 });
  }

  if (ctx.user.role !== 'admin') {
    // Global keys are admin-only in both directions.
    if (!key.teamId) {
      return json({ error: 'API key not found' }, { status: 404 });
    }
    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, key.teamId), eq(teamMembers.userId, ctx.user.id)))
      .get();

    if (!membership || membership.role !== 'owner') {
      return json({ error: 'Team owner access required' }, { status: 403 });
    }
  }

  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return json({ success: true });
}
