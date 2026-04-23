/**
 * GET /api/auth/oidc/generic
 * Initiate the generic OIDC Auth Code + PKCE flow.
 */
import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { oidcConfig } from '$lib/db/schema';
import crypto from 'crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export async function GET({ url, cookies }: { url: URL; cookies: any }) {
  const cfg = await db.select().from(oidcConfig).get();

  if (!cfg || !cfg.enabled || !cfg.authorizationEndpoint || !cfg.clientId) {
    return new Response('Generic OIDC is not configured or disabled', { status: 404 });
  }

  // Generate state (CSRF protection)
  const state = base64url(crypto.randomBytes(32));

  // Generate PKCE code_verifier and code_challenge
  const codeVerifier = base64url(crypto.randomBytes(96));
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );

  // Store state and code_verifier in secure cookies (5 minute TTL)
  const cookieOpts = {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax' as const,
    maxAge: 300,
    path: '/',
  };
  cookies.set('oidc_state', state, cookieOpts);
  if (cfg.usePkce) {
    cookies.set('oidc_verifier', codeVerifier, cookieOpts);
  }

  // Callback URL
  const callbackUrl = `${url.origin}/api/auth/oidc/generic/callback`;

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: callbackUrl,
    scope: cfg.scopes ?? 'openid email profile',
    state,
  });

  if (cfg.usePkce) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  throw redirect(302, `${cfg.authorizationEndpoint}?${params.toString()}`);
}
