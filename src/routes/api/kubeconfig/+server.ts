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
import { apiKeys, teams } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireTeamOwner, authErrorResponse } from '$lib/server/auth';
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
  // This endpoint mints an API key, so it must apply exactly the same rules as
  // POST /api/api-keys: a global (teamId: null) key reaches every team through
  // the k8s API and is admin-only, and a team key is an owner-level grant.
  // Plain membership is not enough — otherwise this route is a way around them.
  let ctx;
  try {
    ctx = await requireAuth(cookies);
  } catch (error) {
    return authErrorResponse(error);
  }
  const user = ctx.user;

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

    try {
      await requireTeamOwner(cookies, teamId);
    } catch (error) {
      return authErrorResponse(error);
    }
    teamSlug = team.slug;
  } else {
    try {
      await requireAdmin(cookies);
    } catch {
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
  const keyId = crypto.randomUUID();

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

  // Only disable certificate verification for plain-HTTP (local) instances,
  // where there is no certificate to verify.  Emitting it unconditionally would
  // tell every kubectl user to accept any certificate for a connection that
  // carries a bearer token with write access to their team.
  const tlsLine = origin.startsWith('https:') ? '' : '\n    insecure-skip-tls-verify: true';

  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${serverUrl}${tlsLine}
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
