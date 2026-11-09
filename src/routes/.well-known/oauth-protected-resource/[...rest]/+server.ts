/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint.
 *
 * How an MCP client that got a 401 learns where to obtain a token: the
 * `WWW-Authenticate` challenge points here, and this names the identity
 * provider. Served at both `/.well-known/oauth-protected-resource` and the
 * path-suffixed `/.well-known/oauth-protected-resource/mcp`, since clients try
 * either.
 */
import type { RequestHandler } from './$types';
import { mcpConfig } from '$lib/server/mcp/auth';

export const GET: RequestHandler = ({ params }) => {
  const config = mcpConfig();
  if (!config || (params.rest && params.rest !== 'mcp')) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      resource: config.resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Rudder',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        // Readable from a browser-based MCP client on another origin; it is
        // public metadata and carries nothing about any caller.
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
};
