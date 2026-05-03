/**
 * Returns a deterministic envelope secret for the authenticated user.
 * Used by the browser-side key vault to encrypt/decrypt SSH keys in localStorage.
 *
 * The envelope is derived from HMAC-SHA256(ENCRYPTION_KEY, userId), so:
 * - Different users get different envelopes (keys can't be shared between accounts)
 * - Same user always gets the same envelope (keys persist across sessions)
 * - Server never stores the SSH keys — only provides the envelope for client-side crypto
 */
import { json } from '@sveltejs/kit';
import { createHmac } from 'crypto';
import { env } from '$lib/server/env';

export async function GET({ cookies }: { cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Deterministic per-user envelope: HMAC-SHA256(ENCRYPTION_KEY, userId)
  const envelope = createHmac('sha256', env.ENCRYPTION_KEY)
    .update(userId)
    .digest('hex');

  return json({ envelope });
}
