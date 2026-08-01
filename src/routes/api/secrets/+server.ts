import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { secrets, teamMembers, auditLogs } from '$lib/db/schema';
import { eq, and, or, inArray } from 'drizzle-orm';
import { encrypt, decrypt } from '$lib/server/encryption';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';
import {
  authErrorResponse,
  requireAuth,
  type AuthContext,
} from '$lib/server/auth';

/** Team IDs the caller belongs to. */
async function teamIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all();
  return rows.map((r) => r.teamId);
}

/**
 * Whether the caller may read the plaintext of a secret.
 *
 * Global secrets are readable only by admins.  Non-admins can see that a
 * global secret exists (it is injected into their containers, so the name is
 * useful) but never its value.
 */
async function canReveal(ctx: AuthContext, secret: typeof secrets.$inferSelect): Promise<boolean> {
  if (ctx.user.role === 'admin') return true;
  if (secret.scope === 'global') return false;
  if (!secret.teamId) return false;
  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ctx.user.id), eq(teamMembers.teamId, secret.teamId)))
    .get();
  return !!membership;
}

/** Shape a secret for the list response — never includes the plaintext. */
function listShape(s: typeof secrets.$inferSelect, revealable: boolean) {
  const { value: _value, ...rest } = s;
  return {
    ...rest,
    revealable,
    createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt as any).toISOString(),
    updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : new Date(s.updatedAt as any).toISOString(),
  };
}

export const GET: RequestHandler = async ({ cookies, url }) => {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  // ── Single-secret reveal ────────────────────────────────────
  // Plaintext is only ever served one secret at a time, on explicit request,
  // and each disclosure is recorded in the audit log.
  const revealId = url.searchParams.get('reveal');
  if (revealId) {
    const secret = await db.select().from(secrets).where(eq(secrets.id, revealId)).get();
    if (!secret) return json({ error: 'Secret not found' }, { status: 404 });

    if (!(await canReveal(ctx, secret))) {
      return json({ error: 'Not authorized to read this secret' }, { status: 403 });
    }

    let value: string;
    try {
      value = decrypt(secret.value);
    } catch {
      return json({ error: 'Secret could not be decrypted' }, { status: 500 });
    }

    try {
      await db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        userId: ctx.user.id,
        teamId: secret.teamId,
        action: 'REVEAL',
        resourceType: 'secret',
        resourceId: secret.id,
        details: JSON.stringify({ name: secret.name, scope: secret.scope }),
        createdAt: new Date(),
      });
    } catch (e) {
      console.error('Failed to write secret reveal audit log:', e);
    }

    return json({ id: secret.id, name: secret.name, value });
  }

  // ── Listing ─────────────────────────────────────────────────
  const urlTeam = url.searchParams.get('team');
  let rows: typeof secrets.$inferSelect[];

  if (ctx.user.role === 'admin') {
    rows = urlTeam && urlTeam !== 'all'
      ? await db.select().from(secrets)
          .where(or(eq(secrets.scope, 'global'), eq(secrets.teamId, urlTeam))).all()
      : await db.select().from(secrets).all();
  } else {
    const teamIds = await teamIdsFor(ctx.user.id);
    const targetTeamIds =
      urlTeam && urlTeam !== 'all'
        ? (teamIds.includes(urlTeam) ? [urlTeam] : [])
        : teamIds;

    rows = targetTeamIds.length > 0
      ? await db.select().from(secrets)
          .where(or(eq(secrets.scope, 'global'), inArray(secrets.teamId, targetTeamIds))).all()
      : await db.select().from(secrets).where(eq(secrets.scope, 'global')).all();
  }

  const result = [];
  for (const s of rows) {
    result.push(listShape(s, await canReveal(ctx, s)));
  }
  return json(result);
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  let body;
  try {
    body = await parseJsonBody(request, schemas.createSecret);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { name, value, description, scope, teamId } = body;
  const finalScope = scope === 'global' ? 'global' : 'team';

  if (finalScope === 'global' && ctx.user.role !== 'admin') {
    return json({ error: 'Only admins can create global secrets' }, { status: 403 });
  }

  if (finalScope === 'team') {
    // A team secret with no team would be invisible to every non-admin and
    // injected into nothing — reject it rather than creating an orphan.
    if (!teamId) {
      return json({ error: 'teamId is required for team-scoped secrets' }, { status: 400 });
    }
    if (ctx.user.role !== 'admin') {
      const membership = await db.select().from(teamMembers)
        .where(and(eq(teamMembers.userId, ctx.user.id), eq(teamMembers.teamId, teamId)))
        .get();
      if (!membership) return json({ error: 'Not a member of this team' }, { status: 403 });
    }
  }

  const now = new Date();
  const id = crypto.randomUUID();

  await db.insert(secrets).values({
    id,
    name,
    value: encrypt(value),
    description: description || null,
    scope: finalScope,
    teamId: finalScope === 'team' ? teamId! : null,
    createdBy: ctx.user.id,
    createdAt: now,
    updatedAt: now,
  });

  return json(
    { id, name, scope: finalScope, teamId: finalScope === 'team' ? teamId : null },
    { status: 201 },
  );
};

export const PATCH: RequestHandler = async ({ request, cookies }) => {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  const body = await request.json();
  const { id, name, value, description } = body;
  if (!id) return json({ error: 'Secret ID required' }, { status: 400 });

  const existing = await db.select().from(secrets).where(eq(secrets.id, id)).get();
  if (!existing) return json({ error: 'Secret not found' }, { status: 404 });

  // Team membership governs edit rights, matching what the listing shows.
  // Keying on createdBy meant teammates could see a secret they could not edit.
  if (!(await canReveal(ctx, existing))) {
    return json({ error: 'Not authorized to edit this secret' }, { status: 403 });
  }

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (value !== undefined) updates.value = encrypt(value);
  if (description !== undefined) updates.description = description;

  await db.update(secrets).set(updates).where(eq(secrets.id, id));
  return json({ success: true });
};

export const DELETE: RequestHandler = async ({ url, cookies }) => {
  let ctx: AuthContext;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }

  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Secret ID required' }, { status: 400 });

  const existing = await db.select().from(secrets).where(eq(secrets.id, id)).get();
  if (!existing) return json({ error: 'Secret not found' }, { status: 404 });

  if (!(await canReveal(ctx, existing))) {
    return json({ error: 'Not authorized to delete this secret' }, { status: 403 });
  }

  await db.delete(secrets).where(eq(secrets.id, id));
  return json({ success: true });
};
