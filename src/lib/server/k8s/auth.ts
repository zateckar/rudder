/**
 * Kubernetes-compatible API authentication using Rudder API keys.
 *
 * API keys (Bearer tokens) are validated against the `api_keys` table.
 * Keys can be global (access all teams) or team-scoped.
 */

import { db } from '$lib/db';
import { apiKeys, teams } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { hashKey } from '$lib/server/encryption';
import { touchApiKey } from '$lib/server/api-keys';

export interface K8sAuthContext {
  apiKeyId: string;
  teamId: string | null;
  /** true when the key has no teamId → can access all teams */
  isGlobal: boolean;
}

export async function authenticateK8s(request: Request): Promise<K8sAuthContext | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const kh = hashKey(token);
  const apiKey = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, kh)).get();
  if (!apiKey) return null;
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

  // Update lastUsedAt (best-effort, don't block), at most once per interval.
  // Every kubectl call comes through here, reads included, so writing on each
  // one put a database write in front of the whole hot path.
  await touchApiKey(apiKey.id, apiKey.lastUsedAt);

  return {
    apiKeyId: apiKey.id,
    teamId: apiKey.teamId,
    isGlobal: !apiKey.teamId,
  };
}

/** Resolve a team by its slug and verify the auth context has access. */
export async function resolveTeamBySlug(ctx: K8sAuthContext, slug: string) {
  const team = await db.select().from(teams).where(eq(teams.slug, slug)).get();
  if (!team) return null;
  if (!ctx.isGlobal && ctx.teamId !== team.id) return null;
  return team;
}

/** Return all teams the auth context may access. */
export async function getAccessibleTeams(ctx: K8sAuthContext) {
  if (ctx.isGlobal) {
    return db.select().from(teams).all();
  }
  if (!ctx.teamId) return [];
  const team = await db.select().from(teams).where(eq(teams.id, ctx.teamId)).get();
  return team ? [team] : [];
}

/** Return a Kubernetes Status error response. */
export function k8sError(status: number, message: string, reason?: string) {
  return new Response(
    JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message,
      reason:
        reason ||
        (status === 401
          ? 'Unauthorized'
          : status === 403
            ? 'Forbidden'
            : status === 404
              ? 'NotFound'
              : status === 409
                ? 'AlreadyExists'
                : status === 405
                  ? 'MethodNotAllowed'
                  : status === 422
                    ? 'Invalid'
                    : 'BadRequest'),
      code: status,
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Return a JSON response with the standard K8s content-type. */
export function k8sJson(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
