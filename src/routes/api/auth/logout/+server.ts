import { json } from '@sveltejs/kit';
import { getSessionIdFromCookies, destroySession, deleteSessionCookie } from '#lib/auth/index.ts';

export const POST = async ({ cookies }: { cookies: any }) => {
  const sessionId = getSessionIdFromCookies(cookies);
  
  if (sessionId) {
    await destroySession(sessionId);
    deleteSessionCookie(cookies);
  }
  
  return json({ success: true, redirect: '/login' });
};
