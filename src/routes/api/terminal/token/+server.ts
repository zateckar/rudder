import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { storeTerminalToken } from '$lib/server/terminal-tokens';

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { containerId, workerId } = body;

  if (!containerId && !workerId) {
    return json({ error: 'Container ID or Worker ID required' }, { status: 400 });
  }

  // Verify resource exists
  if (containerId) {
    const container = await db.select().from(containers).where(eq(containers.id, containerId)).get();
    if (!container) return json({ error: 'Container not found' }, { status: 404 });
  }
  if (workerId) {
    const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
    if (!worker) return json({ error: 'Worker not found' }, { status: 404 });
    if (!worker.sshKeyId) return json({ error: 'Worker SSH not configured' }, { status: 400 });
  }

  // Generate a short-lived token (5 minutes) for terminal WebSocket handshake.
  // The WebSocket server validates and immediately consumes the token (single-use).
  const tokenId = uuid();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  storeTerminalToken(tokenId, {
    containerId,
    workerId,
    userId,
    createdAt: new Date(),
    expiresAt,
  });

  return json({
    token: tokenId,
    expiresIn: 300, // seconds
  });
}
