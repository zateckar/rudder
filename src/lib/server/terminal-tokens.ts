/**
 * Shared in-memory store for short-lived terminal access tokens.
 *
 * Tokens are issued by POST /api/terminal/token (requires a valid user session)
 * and consumed by the WebSocket terminal server.  Any token not present in this
 * store — or that has expired — is rejected immediately.
 */

export interface TerminalTokenData {
  containerId?: string;
  workerId?: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

// Module-level singleton so the same Map is shared across all imports within a
// single Node.js process (SvelteKit server-side).
const tokenStore = new Map<string, TerminalTokenData>();

export function storeTerminalToken(tokenId: string, data: TerminalTokenData): void {
  tokenStore.set(tokenId, data);
  purgeExpiredTokens();
}

export function validateTerminalToken(
  token: string
): { containerId?: string; workerId?: string; userId: string } | null {
  const data = tokenStore.get(token);
  if (!data) return null;

  if (data.expiresAt < new Date()) {
    tokenStore.delete(token);
    return null;
  }

  // Single-use: remove the token after successful validation so it cannot be
  // replayed by a second WebSocket connection.
  tokenStore.delete(token);

  return {
    containerId: data.containerId,
    workerId: data.workerId,
    userId: data.userId,
  };
}

function purgeExpiredTokens(): void {
  const now = new Date();
  for (const [id, data] of tokenStore.entries()) {
    if (data.expiresAt < now) {
      tokenStore.delete(id);
    }
  }
}
