import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireContainer, requireWorker, route } from '$lib/server/auth';
import { storeTerminalToken } from '$lib/server/terminal-tokens';
import { parseJsonBody, schemas } from '$lib/server/validation';

export const POST: RequestHandler = route(async (event) => {
  const { containerId, workerId } = await parseJsonBody(event.request, schemas.terminalToken);

  if (!containerId && !workerId) {
    return json({ error: 'Container ID or Worker ID required' }, { status: 400 });
  }
  if (containerId && workerId) {
    return json({ error: 'Provide either containerId or workerId, not both' }, { status: 400 });
  }

  // Authorize against the specific resource the token will be bound to.  The
  // WebSocket handler trusts the token alone, so this is the only place the
  // caller's permission to reach this container/host is ever checked.
  const { ctx } = containerId
    ? await requireContainer(event, containerId)
    // A host shell is unrestricted root on the worker — admins only.
    : await requireWorker(event, workerId!);
  const userId = ctx.user.id;

  // Generate a short-lived token (5 minutes) for terminal WebSocket handshake.
  // The WebSocket server validates and immediately consumes the token (single-use).
  const tokenId = crypto.randomUUID();
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
});
