import { json } from '@sveltejs/kit';
import {
  authErrorResponse,
  canManageWorker,
  requireContainerAccess,
} from '$lib/server/auth';
import { storeTerminalToken } from '$lib/server/terminal-tokens';
import { parseJsonBody, ValidationError, schemas } from '$lib/server/validation';

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  let body;
  try {
    body = await parseJsonBody(request, schemas.terminalToken);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const { containerId, workerId } = body;

  if (!containerId && !workerId) {
    return json({ error: 'Container ID or Worker ID required' }, { status: 400 });
  }
  if (containerId && workerId) {
    return json({ error: 'Provide either containerId or workerId, not both' }, { status: 400 });
  }

  // Authorize against the specific resource the token will be bound to.  The
  // WebSocket handler trusts the token alone, so this is the only place the
  // caller's permission to reach this container/host is ever checked.
  let userId: string;
  try {
    if (containerId) {
      const { ctx } = await requireContainerAccess(cookies, containerId);
      userId = ctx.user.id;
    } else {
      // A host shell is unrestricted root on the worker — admins only.
      const { ctx } = await canManageWorker(cookies, workerId!);
      userId = ctx.user.id;
    }
  } catch (error) {
    return authErrorResponse(error);
  }

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
}
