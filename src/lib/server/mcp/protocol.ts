/**
 * The MCP wire protocol: JSON-RPC 2.0 over the Streamable HTTP transport.
 *
 * Stateless, and JSON responses only. Every tool here answers promptly — the
 * slow work runs as a task (see tasks.ts) — so there is nothing to stream, and
 * the spec lets a server answer a POST with `application/json` instead of an SSE
 * stream. No session id is issued: each request carries its own bearer token
 * and is authorized on its own, which also means any Rudder process can answer
 * any request.
 */
import type { McpPrincipal } from './auth';
import { callTool, hasTool, toolList } from './tools';

/** Newest first. The first is offered to a client asking for one we do not know. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const SERVER_INFO = { name: 'rudder', title: 'Rudder', version: '1.0.0' };

const INSTRUCTIONS =
  'Operate the applications of the teams this token acts for. Start with list_applications. ' +
  'deploy_application, rollback_application, control_application and scale_application return a taskId at once; ' +
  'poll get_task until its status is no longer "running", then report the outcome. ' +
  'For a failed deploy, get_deployment shows what the containers printed.';

type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isRequestShaped(msg: unknown): msg is JsonRpcRequest {
  return (
    !!msg &&
    typeof msg === 'object' &&
    (msg as any).jsonrpc === '2.0' &&
    typeof (msg as any).method === 'string' &&
    ((msg as any).id === undefined || typeof (msg as any).id === 'string' || typeof (msg as any).id === 'number')
  );
}

/**
 * Handle one message. Null for anything that takes no response: notifications,
 * and responses to requests this server never sends.
 */
export async function handleMessage(principal: McpPrincipal, msg: unknown): Promise<JsonRpcResponse | null> {
  if (msg && typeof msg === 'object' && !('method' in msg) && ('result' in msg || 'error' in msg)) return null;
  if (!isRequestShaped(msg)) {
    const id = msg && typeof msg === 'object' && 'id' in msg ? ((msg as any).id ?? null) : null;
    return rpcError(typeof id === 'string' || typeof id === 'number' ? id : null, INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  // A notification: no id, no answer.
  if (msg.id === undefined) return null;
  const id = msg.id as JsonRpcId;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolList() } };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !hasTool(name)) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      }
      try {
        return { jsonrpc: '2.0', id, result: await callTool(principal, name, params.arguments) };
      } catch (e) {
        console.error('[mcp] tools/call failed:', e);
        return rpcError(id, INTERNAL_ERROR, 'Internal error');
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}
