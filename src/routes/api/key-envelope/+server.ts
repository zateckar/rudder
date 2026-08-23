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
import type { RequestHandler } from './$types';
import { createHmac } from 'crypto';
import { env } from '$lib/server/env';
import { requireUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  const { user } = requireUser(event);

  // Deterministic per-user envelope: HMAC-SHA256(ENCRYPTION_KEY, userId)
  const envelope = createHmac('sha256', env.ENCRYPTION_KEY).update(user.id).digest('hex');

  return json({ envelope });
});
