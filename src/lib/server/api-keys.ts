/**
 * Recording that an API key is in use.
 *
 * Shared by the request hook and the Kubernetes-compatible surface so both are
 * held to the same write interval — `authenticateK8s` used to write on every
 * call, which put the coarsening somewhere it did not matter and left it out of
 * the one path that actually needed it.
 */
import { db } from '$lib/db';
import { apiKeys } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * How stale `lastUsedAt` is allowed to get.
 *
 * This column answers "is this key still in use, and roughly when last?" — a
 * question nobody asks to the second. Writing it on every authenticated request
 * put a database write in front of every `kubectl` call, including the reads,
 * which is the hot path for the Kubernetes-compatible API.
 */
export const API_KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Record that a key was used, at most once per interval. */
export async function touchApiKey(id: string, lastUsedAt: Date | null): Promise<void> {
  const now = new Date();
  if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < API_KEY_TOUCH_INTERVAL_MS) {
    return;
  }
  try {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id));
  } catch (e) {
    // Never fail a request because we could not record its timestamp.
    console.error('[auth] Could not update API key lastUsedAt:', e);
  }
}
