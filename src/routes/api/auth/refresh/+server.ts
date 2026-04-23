import { json } from '@sveltejs/kit';
import { refreshSession, getSessionIdFromCookies, validateSession } from '$lib/auth';

export async function POST({ cookies }: { cookies: any }) {
  const sessionId = getSessionIdFromCookies(cookies);
  
  if (!sessionId) {
    return json({ error: 'No session' }, { status: 401 });
  }
  
  const userId = await validateSession(sessionId);
  
  if (!userId) {
    return json({ error: 'Invalid session' }, { status: 401 });
  }
  
  const refreshed = await refreshSession(sessionId);
  
  if (!refreshed) {
    return json({ error: 'Failed to refresh session' }, { status: 500 });
  }
  
  return json({ success: true });
}
