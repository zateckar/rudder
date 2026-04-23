import { redirect } from '@sveltejs/kit';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  
  if (!sessionId) {
    throw redirect(303, '/login');
  }
  
  const userId = await validateSession(sessionId);
  
  if (!userId) {
    throw redirect(303, '/login');
  }
  
  throw redirect(303, '/dashboard');
};
