/**
 * Generate a kubeconfig file for kubectl access.
 *
 * POST /api/kubeconfig
 * Body: { teamId?: string, name?: string }
 *
 * Creates a new API key and returns a ready-to-use kubeconfig YAML
 * that points to this Rudder instance's K8s-compatible API.
 */

import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { apiKeys, teams, teamMembers, users } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getSessionIdFromCookies, validateSession } from '$lib/auth';
import { v4 as uuid } from 'uuid';
import { hashKey } from '$lib/server/encryption';
import { randomBytes } from 'crypto';

export async function POST({
  request,
  cookies,
  url,
}: {
  request: Request;
  cookies: any;
  url: URL;
}) {
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) {
    return json({ error: 'User not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const teamId: string | null = body.teamId || null;
  const keyName: string = body.name || `kubectl-${user.username}`;

  // Determine the default namespace for kubeconfig
  let teamSlug = '';

  if (teamId) {
    const team = await db
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .get();
    if (!team) return json({ error: 'Team not found' }, { status: 404 });

    if (user.role !== 'admin') {
      const membership = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.userId, userId),
            eq(teamMembers.teamId, teamId),
          ),
        )
        .get();
      if (!membership) {
        return json(
          { error: 'Not a member of this team' },
          { status: 403 },
        );
      }
    }
    teamSlug = team.slug;
  } else {
    if (user.role !== 'admin') {
      return json(
        {
          error:
            'Only admins can create global kubeconfig. Pass teamId for team-scoped access.',
        },
        { status: 403 },
      );
    }
    const allTeams = await db.select().from(teams).all();
    teamSlug = allTeams[0]?.slug || 'default';
  }

  // Generate API key
  const rawKey = 'rud_' + randomBytes(24).toString('base64url');
  const keyId = uuid();

  await db.insert(apiKeys).values({
    id: keyId,
    name: keyName,
    keyHash: hashKey(rawKey),
    teamId,
    expiresAt: null,
    createdAt: new Date(),
  });

  const origin = url.origin;
  const serverUrl = `${origin}/k8s`;

  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${serverUrl}
    insecure-skip-tls-verify: true
  name: rudder
contexts:
- context:
    cluster: rudder
    user: rudder-user
    namespace: ${teamSlug}
  name: rudder
current-context: rudder
preferences: {}
users:
- name: rudder-user
  user:
    token: ${rawKey}
`;

  return json({
    kubeconfig,
    apiKey: rawKey,
    apiKeyId: keyId,
    serverUrl,
    namespace: teamSlug,
  });
}
