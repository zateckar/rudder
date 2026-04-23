import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/env';
import { handleOIDCCallback, type OIDCProvider } from '$lib/auth/oidc';
import { setSessionCookie } from '$lib/auth';

const VALID_PROVIDERS: OIDCProvider[] = ['google', 'github', 'okta', 'auth0'];

export const GET: RequestHandler = async ({ params, cookies, url }) => {
  const provider = params.provider as OIDCProvider;
  
  if (!VALID_PROVIDERS.includes(provider)) {
    throw redirect(303, '/login?error=invalid_provider');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    console.error('OIDC error:', error, url.searchParams.get('error_description'));
    throw redirect(303, `/login?error=${error}`);
  }

  if (!code || !state) {
    throw redirect(303, '/login?error=missing_params');
  }

  // Verify state
  const storedState = cookies.get(`oidc_state_${provider}`);
  if (state !== storedState) {
    throw redirect(303, '/login?error=invalid_state');
  }

  // Clear state cookie
  cookies.delete(`oidc_state_${provider}`, { path: '/' });

  const redirectUri = `${env.PUBLIC_URL}/api/auth/oidc/${provider}/callback`;
  const result = await handleOIDCCallback(provider, code, redirectUri);

  if (!result) {
    throw redirect(303, '/login?error=auth_failed');
  }

  // Set session cookie
  setSessionCookie(cookies, result.sessionId);

  // Redirect to dashboard (or onboarding for new users)
  if (result.isNew) {
    throw redirect(303, '/dashboard?welcome=1');
  }
  
  throw redirect(303, '/dashboard');
};
