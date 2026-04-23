import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/env';
import { generateAuthorizationUrl, type OIDCProvider } from '$lib/auth/oidc';
import { v4 as uuid } from 'uuid';

const VALID_PROVIDERS: OIDCProvider[] = ['google', 'github', 'okta', 'auth0'];

export const GET: RequestHandler = async ({ params, cookies, url }) => {
  const provider = params.provider as OIDCProvider;
  
  if (!VALID_PROVIDERS.includes(provider)) {
    throw redirect(303, '/login?error=invalid_provider');
  }

  const state = uuid();
  const redirectUri = `${env.PUBLIC_URL}/api/auth/oidc/${provider}/callback`;
  
  const authUrl = generateAuthorizationUrl(provider, state, redirectUri);
  
  if (!authUrl) {
    throw redirect(303, '/login?error=provider_not_configured');
  }

  // Store state in cookie for verification
  cookies.set(`oidc_state_${provider}`, state, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
  });

  throw redirect(302, authUrl);
};
