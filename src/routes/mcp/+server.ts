/**
 * The MCP endpoint — Streamable HTTP transport, stateless, JSON responses.
 *
 * Off unless `MCP_OIDC_ISSUER` is set, and then reachable only with an access
 * token from that provider whose audience names a team. See $lib/server/mcp.
 */
import type { RequestHandler } from './$types';
import { authenticateMcp, mcpConfig, originAllowed } from '$lib/server/mcp/auth';
import {
  INVALID_REQUEST,
  PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMessage,
  rpcError,
  type JsonRpcResponse,
} from '$lib/server/mcp/protocol';
import { consume } from '$lib/server/rate-limit';

/** Requests per token subject per minute. Polling get_task every few seconds fits easily. */
const RATE_LIMIT = { limit: 300, windowMs: 60_000 };
const MAX_BATCH = 20;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export const POST: RequestHandler = async ({ request }) => {
  const config = mcpConfig();
  if (!config) return jsonResponse({ error: 'MCP is not enabled on this Rudder installation' }, 404);

  if (!originAllowed(request, config)) return jsonResponse({ error: 'Origin not allowed' }, 403);

  const version = request.headers.get('mcp-protocol-version');
  if (version && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`), 400);
  }

  const auth = await authenticateMcp(request, config);
  if (!auth.ok) return auth.response;

  const limited = consume(`mcp:${auth.principal.subject}`, RATE_LIMIT);
  if (!limited.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': String(limited.retryAfterSeconds) });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, PARSE_ERROR, 'Parse error'), 400);
  }

  // Batches were part of the 2025-03-26 revision and dropped after; accepting
  // them costs nothing and keeps older clients working.
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH) {
      return jsonResponse(rpcError(null, INVALID_REQUEST, `A batch must hold 1–${MAX_BATCH} messages`), 400);
    }
    const responses: JsonRpcResponse[] = [];
    for (const message of body) {
      const response = await handleMessage(auth.principal, message);
      if (response) responses.push(response);
    }
    return responses.length ? jsonResponse(responses) : new Response(null, { status: 202 });
  }

  const response = await handleMessage(auth.principal, body);
  // Notifications and client responses are acknowledged with 202 and no body.
  return response ? jsonResponse(response) : new Response(null, { status: 202 });
};

/**
 * No server-to-client stream: nothing here is ever pushed. 405 is what the
 * transport spec prescribes for a server that does not offer one.
 */
export const GET: RequestHandler = () =>
  new Response(null, { status: 405, headers: { Allow: 'POST' } });

/** No sessions are issued, so there is none to end. */
export const DELETE: RequestHandler = () =>
  new Response(null, { status: 405, headers: { Allow: 'POST' } });
