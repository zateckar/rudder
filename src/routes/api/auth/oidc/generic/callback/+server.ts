/**
 * GET /api/auth/oidc/generic/callback
 * Handle the authorization code callback from the OIDC provider.
 * Exchanges the code for tokens, fetches user info, and creates a session.
 */
import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { oidcConfig, users, userOidc } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createSession, setSessionCookie } from '$lib/auth';
import { resolveTeamNames, syncUserTeams } from '$lib/server/oidc-teams';

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
 * Carry a returning user's provider profile into their Rudder account.
 *
 * The link row's `lastSyncedAt` was the only thing a repeat login touched, so a
 * name change, a department move or a mailbox rename in the IdP never arrived:
 * the users list kept showing whatever the account was created with, indefinitely.
 *
 * `username` and `email` are UNIQUE, and this runs mid-login, so a collision must
 * not be an exception — another account already holding the value means the
 * change is not safely applicable here and is left for an admin. Nothing else on
 * the account is touched: `role` in particular is Rudder's to decide, and
 * overwriting it from the provider would undo every promotion on the next login.
 */
async function refreshOidcProfile(
  userId: string,
  profile: { email: string; username?: string; fullName: string },
): Promise<void> {
  const current = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!current) return;

  const changes: Partial<typeof users.$inferInsert> = {};
  if (profile.fullName && profile.fullName !== current.fullName) changes.fullName = profile.fullName;
  if (profile.email && profile.email !== current.email) changes.email = profile.email;
  if (profile.username && profile.username !== current.username) changes.username = profile.username;

  if (Object.keys(changes).length === 0) return;

  try {
    await db.update(users).set({ ...changes, updatedAt: new Date() }).where(eq(users.id, userId));
  } catch (e: any) {
    console.warn(
      `[oidc/generic] Could not update profile for ${current.username}: ${e.message}. ` +
        `Another account probably holds the new username or email.`,
    );
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
    // Where a group claim can actually live, in decreasing order of how
    // specifically the provider meant it for us.
    //
    // The first two are the point: this used to read `tokenData` — the token
    // endpoint's JSON envelope, whose keys are `access_token`, `id_token`,
    // `expires_in` — and call that "the access token". A provider that puts
    // groups in the token's *claims*, which is where Keycloak's group mapper
    // puts them by default, therefore never matched, and unless the same claim
    // had also been mapped into userinfo the sync silently never ran.
    // `decodeJwtPayload` was written for this and was never called.
    const claimSources: Array<Record<string, any> | null> = [
      decodeJwtPayload(accessToken),
      typeof tokenData.id_token === 'string' ? decodeJwtPayload(tokenData.id_token) : null,
      userInfo,
      // Last, and only for a provider that hangs the claim off the envelope
      // itself. Kept so any deployment that happened to work before still does.
      tokenData,
    ];

    let claimValue: unknown;
    for (const source of claimSources) {
      const found = source?.[cfg.teamClaimName];
      if (found !== undefined && found !== null) {
        claimValue = found;
        break;
      }
    }

    const resolution = resolveTeamNames(claimValue, cfg);
    teamNames = resolution.teamNames;
    teamClaimResolved = resolution.resolved;

    if (resolution.resolved) {
      console.log('[oidc/generic] Extracted teams from claim:', teamNames);
    } else if (claimValue !== undefined && claimValue !== null) {
      console.warn(
        `[oidc/generic] Team claim "${cfg.teamClaimName}" could not be read (${resolution.reason}); ` +
          `leaving memberships alone rather than reading it as "no teams".`,
      );
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

  // Find or create user.
  // The link is stored under provider='auth0' with a `generic:` prefix on the
  // provider id — the enum predates generic OIDC and this reuses one of its
  // slots rather than migrating it.
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
    await refreshOidcProfile(userId, { email, username, fullName });
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
      await refreshOidcProfile(userId, { email, username, fullName });
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