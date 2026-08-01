import { redirect } from '@sveltejs/kit';
import { db, safeUserColumns } from '$lib/db';
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

  // Select explicit columns: the previous `select()` shipped the bcrypt
  // password hash to the browser in every SSR payload.
  const currentUser = await db
    .select(safeUserColumns)
    .from(users)
    .where(eq(users.id, userId))
    .get();

  return {
    user: currentUser,
  };
};
