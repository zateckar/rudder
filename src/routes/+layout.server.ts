import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const load = async ({ cookies, url }: { cookies: any; url: URL }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  
  // Public paths that must not redirect to /login.
  const isPublicPath = url.pathname === '/login' || url.pathname.startsWith('/api/health');

  if (!sessionId) {
    if (!isPublicPath) {
      throw redirect(303, '/login');
    }
    return { user: null };
  }

  const userId = await validateSession(sessionId);

  if (!userId) {
    if (!isPublicPath) {
      throw redirect(303, '/login');
    }
    return { user: null };
  }

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();

  return {
    user: currentUser,
  };
};
