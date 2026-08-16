/**
 * Production entry point.
 *
 * `adapter-node`'s own `build/index.js` cannot serve WebSocket upgrades, and
 * SvelteKit has no hook for them, so the container terminal and `kubectl exec`
 * need an HTTP server we control. This is the smallest such server: it wraps
 * the adapter's request handler unchanged and adds one `upgrade` listener.
 *
 * The app registers its WebSocket routes from `hooks.server.ts` into a registry
 * on `globalThis`, so the handlers here are the app's own — one database
 * connection, one metrics scheduler, no second copy of anything.
 *
 * Run with `bun run server.js` after `bun run build`.
 */
import { createServer } from 'http';
import { handler } from './build/handler.js';

const port = Number(process.env.PORT ?? 7244);
const host = process.env.HOST ?? '0.0.0.0';

const server = createServer(handler);

server.on('upgrade', (request, socket, head) => {
  const registry = globalThis.__rudderWsRegistry;
  if (!registry) {
    // hooks.server.ts has not run yet, so nothing is registered. Refuse rather
    // than leave the socket open: the client retries, and by then the first
    // request will have initialised the app.
    socket.destroy();
    return;
  }

  try {
    // The registry publishes its own dispatch function, so this file needs no
    // import path into the built app — the global object is the whole contract.
    if (!registry.handleWsUpgrade(request, socket, head)) socket.destroy();
  } catch (e) {
    console.error('[ws] upgrade failed:', e);
    socket.destroy();
  }
});

server.listen(port, host, () => {
  console.log(`Rudder listening on http://${host}:${port}`);
});
