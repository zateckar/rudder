/**
 * The terminal WebSocket lives at this path, but it is not served from here.
 *
 * SvelteKit does not handle WebSocket upgrades: a `+server.ts` returning a
 * Response with a `webSocket` property — which is what this file used to do —
 * is never upgraded, so the handshake hung and the terminal never connected.
 * The upgrade is handled on the HTTP server instead, and the handler is
 * registered in `src/lib/server/ws/handlers.ts`.
 *
 * This route exists only to answer a plain HTTP GET with something better than
 * a 404, which would otherwise be the first thing anyone debugging it saw.
 */
export function GET({ request }: { request: Request }) {
  const upgrade = request.headers.get('upgrade');

  if (upgrade?.toLowerCase() === 'websocket') {
    // Reaching this handler with an upgrade header means the HTTP server did
    // not dispatch it: the dev plugin or server.js is missing.
    return new Response(
      'WebSocket upgrade was not handled by the HTTP server. ' +
        'Run the app via `bun run dev` or `bun run server.js`, not `build/index.js`.',
      { status: 500 },
    );
  }

  return new Response(
    'This endpoint accepts WebSocket connections only. Obtain a token from ' +
      'POST /api/terminal/token and offer it as a subprotocol — ' +
      'Sec-WebSocket-Protocol: rudder.terminal.v1, rudder.token.<token>. ' +
      'It is deliberately not read from the query string, which proxies log.',
    { status: 426, headers: { Upgrade: 'websocket' } },
  );
}
