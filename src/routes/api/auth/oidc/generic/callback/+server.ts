/**
 * GET /api/auth/oidc/generic/callback
 * Handle the authorization code callback from the OIDC provider.
 * Exchanges the code for tokens, fetches user info, and creates a session.
 */
import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { oidcConfig, users, userOidc, teams, teamMembers } from '$lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { createSession, setSessionCookie } from '$lib/auth';

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Make the user's team memberships match the claim, in both directions.
 *
 * This used only to add. A membership granted from an IdP group therefore
 * outlived removal from that group indefinitely: revoking someone's access in
 * the identity provider left their Rudder access exactly as it was, which is the
 * opposite of what configuring a team claim is for.
 *
 * So once a team claim is configured, the claim is authoritative for this user's
 * plain memberships: every `member` row naming a team the claim does not is
 * removed. Nothing records where a membership came from, so that necessarily
 * includes rows an admin added by hand in Rudder — with a team claim configured,
 * hand-granting a member team is not durable, and the way to grant lasting access
 * is `owner`. `owner` rows are exempt precisely so there is such a way, and so
 * the IdP cannot silently unseat a team's owner.
 *
 * Only called when the claim actually resolved to a list — see the call site.
 * Treating an absent or malformed claim as "no teams" would turn one provider
 * misconfiguration into a mass revocation.
 */
export async function syncUserTeams(userId: string, teamNames: string[]): Promise<void> {
  const now = new Date();

  // Get existing teams
  const existingTeams = await db.select().from(teams).all();
  const existingTeamMap = new Map(existingTeams.map(t => [t.name.toLowerCase(), t]));

  // Get user's current team memberships
  const currentMemberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
  const currentTeamIds = new Set(currentMemberships.map(m => m.teamId));

  // Determine teams to create and join
  const teamsToJoin: string[] = [];
  const claimedTeamIds = new Set<string>();
  for (const teamName of teamNames) {
    const normalizedName = teamName.toLowerCase();
    if (existingTeamMap.has(normalizedName)) {
      const team = existingTeamMap.get(normalizedName)!;
      claimedTeamIds.add(team.id);
      if (!currentTeamIds.has(team.id)) {
        teamsToJoin.push(team.id);
      }
    } else {
      // Create new team
      const teamId = crypto.randomUUID();
      const slug = teamName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
      await db.insert(teams).values({
        id: teamId,
        name: teamName,
        slug: `${slug}-${Date.now().toString(36)}`,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      claimedTeamIds.add(teamId);
      teamsToJoin.push(teamId);
    }
  }

  // Add user to new teams
  for (const teamId of teamsToJoin) {
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'member',
      joinedAt: now,
    }).onConflictDoNothing();
  }

  // Withdraw memberships the claim no longer asserts.
  for (const membership of currentMemberships) {
    if (claimedTeamIds.has(membership.teamId)) continue;
    if (membership.role === 'owner') continue;
    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, membership.teamId)));
    console.log(`[oidc/generic] Removed membership of team ${membership.teamId} — not in claim`);
  }
}

export async function GET({ url, cookies }: { url: URL; cookies: any }) {
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    console.error('[oidc/generic] Provider returned error:', error, url.searchParams.get('error_description'));
    throw redirect(302, '/login?error=oidc_provider_error');
  }

  if (!code || !state) {
    throw redirect(302, '/login?error=oidc_missing_params');
  }

  // Validate state cookie (CSRF check)
  const savedState = cookies.get('oidc_state');
  if (!savedState || savedState !== state) {
    console.error('[oidc/generic] State mismatch — possible CSRF');
    throw redirect(302, '/login?error=oidc_state_mismatch');
  }
  cookies.delete('oidc_state', { path: '/' });

  const cfg = await db.select().from(oidcConfig).get();
  if (!cfg || !cfg.enabled || !cfg.tokenEndpoint || !cfg.clientId) {
    throw redirect(302, '/login?error=oidc_not_configured');
  }

  const callbackUrl = `${url.origin}/api/auth/oidc/generic/callback`;

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    client_id: cfg.clientId,
  });

  if (cfg.clientSecret) {
    tokenBody.set('client_secret', cfg.clientSecret);
  }

  // Attach PKCE code_verifier if used
  if (cfg.usePkce) {
    const verifier = cookies.get('oidc_verifier');
    if (!verifier) {
      console.error('[oidc/generic] Missing PKCE verifier cookie');
      throw redirect(302, '/login?error=oidc_pkce_missing');
    }
    tokenBody.set('code_verifier', verifier);
    cookies.delete('oidc_verifier', { path: '/' });
  }

  let accessToken: string;
  let tokenData: Record<string, any>;
  try {
    const tokenRes = await fetch(cfg.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('[oidc/generic] Token exchange failed:', tokenRes.status, body);
      throw redirect(302, '/login?error=oidc_token_error');
    }

    tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    if (!accessToken) throw new Error('No access_token in response');
  } catch (e: any) {
    if (e?.location) throw e; // Re-throw SvelteKit redirects
    console.error('[oidc/generic] Token error:', e.message);
    throw redirect(302, '/login?error=oidc_token_error');
  }

  // Fetch user info
  if (!cfg.userinfoEndpoint) {
    throw redirect(302, '/login?error=oidc_no_userinfo');
  }

  let userInfo: { sub?: string; email?: string; name?: string; preferred_username?: string; display_name?: string; [key: string]: any };
  try {
    const userRes = await fetch(cfg.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!userRes.ok) throw new Error(`Userinfo ${userRes.status}`);
    userInfo = await userRes.json();
  } catch (e: any) {
    console.error('[oidc/generic] Userinfo error:', e.message);
    throw redirect(302, '/login?error=oidc_userinfo_error');
  }

  // Extract team names from claims
  let teamNames: string[] = [];
  // Whether the claim was found *and* was a list. Only then is it authoritative
  // enough to remove memberships with: an empty list means "this user is in no
  // groups" and must revoke, whereas a claim the provider did not send at all
  // means "ask again later" and must change nothing.
  let teamClaimResolved = false;
  if (cfg.teamClaimName) {
    // Try access token first
    let claimValue = tokenData[cfg.teamClaimName];

    // Fallback to userinfo endpoint
    if (claimValue === undefined || claimValue === null) {
      claimValue = userInfo[cfg.teamClaimName];
    }

    if (claimValue !== undefined && claimValue !== null) {
      // If claim is an object with a key, extract the array
      if (typeof claimValue === 'object' && !Array.isArray(claimValue) && cfg.teamClaimKey) {
        claimValue = claimValue[cfg.teamClaimKey];
      }

      if (Array.isArray(claimValue)) {
        teamNames = claimValue.filter((t): t is string => typeof t === 'string');
        teamClaimResolved = true;
        console.log('[oidc/generic] Extracted teams from claim:', teamNames);
      } else {
        console.warn(
          `[oidc/generic] Team claim "${cfg.teamClaimName}" is not a list; leaving memberships ` +
            `alone rather than reading it as "no teams".`,
        );
      }
    }
  }

  const providerId = userInfo.sub ?? userInfo.email;
  const email = userInfo.email;
  const username = userInfo.preferred_username;
  const fullName = userInfo.display_name || userInfo.name || userInfo.preferred_username || email?.split('@')[0] || 'User';

  if (!providerId || !email) {
    console.error('[oidc/generic] Missing sub/email in userinfo:', userInfo);
    throw redirect(302, '/login?error=oidc_missing_userinfo');
  }

  // Find or create user
  const PROVIDER = 'google' as const; // reuse existing enum; generic maps to 'google' slot
  // Better: check if OIDC link exists by provider_id in user_oidc (using a text search)
  let userId: string;

  // Check existing OIDC link (we store generic provider as provider='auth0' with a unique providerId)
  const existingLink = await db
    .select()
    .from(userOidc)
    .where(and(eq(userOidc.provider, 'auth0'), eq(userOidc.providerId, `generic:${providerId}`)))
    .get();

  if (existingLink) {
    userId = existingLink.userId;
    await db.update(userOidc).set({ lastSyncedAt: new Date() }).where(eq(userOidc.id, existingLink.id));
  } else {
    // Check by email
    const existingUser = await db.select().from(users).where(eq(users.email, email)).get();

    if (existingUser) {
      // Adopting an existing account on the strength of a matching email address
      // is an account takeover unless the provider vouches for the address. An
      // IdP that lets a user set their own unverified email — or any tenant of a
      // shared provider — could otherwise claim the admin account simply by
      // presenting its email. Require the provider to say it verified it.
      if (userInfo.email_verified !== true) {
        console.warn(
          '[oidc/generic] Refusing to link to existing account: provider did not report ' +
            'email_verified for',
          email,
        );
        throw redirect(302, '/login?error=oidc_email_unverified');
      }

      userId = existingUser.id;
      // Link this OIDC to the existing user
      await db.insert(userOidc).values({
        id: crypto.randomUUID(),
        userId,
        provider: 'auth0',
        providerId: `generic:${providerId}`,
        lastSyncedAt: new Date(),
      });
    } else {
      // Check if registration is allowed
      if (!cfg.allowRegistration) {
        console.warn('[oidc/generic] Registration disabled, user not found:', email);
        throw redirect(302, '/login?error=oidc_registration_disabled');
      }

      // Create new user
      userId = crypto.randomUUID();
      const now = new Date();
      const finalUsername = username || (() => {
        const base = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
        return `${base}${Math.floor(Math.random() * 9000) + 1000}`;
      })();

      await db.insert(users).values({
        id: userId,
        username: finalUsername,
        email,
        passwordHash: null,
        fullName,
        role: 'member',
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(userOidc).values({
        id: crypto.randomUUID(),
        userId,
        provider: 'auth0',
        providerId: `generic:${providerId}`,
        lastSyncedAt: now,
      });
    }
  }

  // Create session
  const sessionId = await createSession(userId);

  // Sync teams if configured.
  //
  // Gated on the claim having resolved, not on it being non-empty. `length > 0`
  // meant the one case revocation exists for — a user removed from every group —
  // was the one case that changed nothing, because an empty list skipped the sync
  // entirely and left every membership in place.
  if (teamClaimResolved) {
    try {
      await syncUserTeams(userId, teamNames);
      console.log(`[oidc/generic] Synced ${teamNames.length} teams for user ${email}`);
    } catch (e: any) {
      console.error('[oidc/generic] Failed to sync teams:', e.message);
    }
  }

  // Set through the shared helper rather than by hand: this copy hard-coded a
  // seven-day lifetime (ignoring SESSION_MAX_AGE) and derived `secure` from
  // url.protocol, which is http behind a terminating proxy — so the session
  // cookie for an https deployment was issued without the Secure attribute.
  setSessionCookie(cookies, sessionId);

  throw redirect(302, '/dashboard');
}
