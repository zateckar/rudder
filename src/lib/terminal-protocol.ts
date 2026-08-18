/**
 * How the terminal WebSocket carries its access token.
 *
 * The token used to travel in the query string — `?token=…`. A URL is the one
 * part of a request that everything logs by default: the reverse proxy's access
 * log, anything with `X-Forwarded-*` in front of it, and the browser's own
 * history. That put a live credential for a container shell into files with a
 * different retention policy and a wider audience than the session cookie.
 *
 * A browser cannot set request headers on a WebSocket, but it can offer
 * subprotocols, and those are sent in `Sec-WebSocket-Protocol`. Headers are not
 * in the default access-log format, so this moves the credential out of the logs
 * without needing a second round trip to exchange it.
 *
 * Shared by the client and the upgrade handler so the two cannot drift apart:
 * a mismatch here does not fail loudly, it just refuses every connection.
 */

/** Echoed back by the server so the browser accepts the handshake. */
export const TERMINAL_SUBPROTOCOL = 'rudder.terminal.v1';

/** Prefix of the subprotocol entry carrying the token itself. */
const TOKEN_PREFIX = 'rudder.token.';

/**
 * The subprotocol list a client offers.
 *
 * Two entries: the one the server echoes, and the credential. Tokens are UUIDs,
 * which are already within the character set a subprotocol token allows — no
 * encoding needed, and none applied, so the server can compare bytes.
 */
export function terminalSubprotocols(token: string): string[] {
  return [TERMINAL_SUBPROTOCOL, `${TOKEN_PREFIX}${token}`];
}

/**
 * Recover the token from a `Sec-WebSocket-Protocol` header value.
 *
 * Returns null when it is absent or malformed, which callers treat exactly as
 * they treat a bad token — there is no useful difference to report.
 */
export function tokenFromSubprotocols(header: string | undefined | null): string | null {
  if (!header) return null;
  for (const raw of header.split(',')) {
    const entry = raw.trim();
    if (entry.startsWith(TOKEN_PREFIX)) {
      const token = entry.slice(TOKEN_PREFIX.length);
      return token.length > 0 ? token : null;
    }
  }
  return null;
}
