/**
 * WebSocket upgrade routing for the SvelteKit app.
 *
 * Neither `@sveltejs/kit` 2.60 nor `adapter-node` serves WebSocket upgrades:
 * a `+server.ts` that returns a Response with a `webSocket` property, or a bare
 * 101, is simply not upgraded — the handshake hangs and the client times out.
 * That is why the container terminal never connected, and why `kubectl exec`
 * could not work either.
 *
 * The upgrade has to be handled on the HTTP server itself, which lives outside
 * the app in both environments: Vite's dev server, and the Node server that
 * wraps `build/handler.js` in production. So the app registers its handlers
 * here and the two servers dispatch through this registry.
 *
 * The registry hangs off `globalThis` deliberately. In dev, Vite's SSR module
 * graph and the plugin are separate module instances; in production the entry
 * script and the bundled app are too. A module-level array would give each of
 * them its own empty copy. One shared object means everyone sees the same
 * handlers and, more importantly, the same database and Podman clients — no
 * second `bun:sqlite` connection, no duplicate schedulers.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

export interface WsRoute {
  /** Does this route own the request? Receives the parsed request URL. */
  match: (url: URL) => boolean;
  /**
   * Called once the socket is upgraded. Reject by closing the socket with an
   * appropriate code; throwing is caught and closes with 1011.
   */
  handle: (socket: WebSocket, request: IncomingMessage, url: URL) => void | Promise<void>;
  /**
   * Pick a subprotocol from what the client offered. `kubectl` negotiates
   * `v5.channel.k8s.io` / `v4.channel.k8s.io` and will not proceed unless the
   * server echoes one back.
   */
  selectProtocol?: (offered: Set<string>) => string | false;
}

interface Registry {
  routes: WsRoute[];
  server: WebSocketServer;
  /**
   * The dispatch function, published here so a plain JavaScript entry point
   * needs no import path into the built app — the global object is the whole
   * contract between the HTTP server and the app.
   */
  handleWsUpgrade: typeof handleWsUpgrade;
}

const KEY = '__rudderWsRegistry';

function registry(): Registry {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = {
      routes: [],
      // noServer: this never listens; it only turns an upgrade into a socket.
      server: new WebSocketServer({ noServer: true }),
      handleWsUpgrade,
    } satisfies Registry;
  }
  return g[KEY] as Registry;
}

/**
 * Register a route. Idempotent per `name` so a dev-server hot reload replaces
 * the handler instead of stacking a second one that never runs.
 */
export function registerWsRoute(name: string, route: WsRoute): void {
  const reg = registry();
  const existing = reg.routes.findIndex((r) => (r as any).__name === name);
  const tagged = Object.assign({}, route, { __name: name });
  if (existing === -1) reg.routes.push(tagged);
  else reg.routes[existing] = tagged;
}

/** Is any handler interested in this path? Used to leave other upgrades alone. */
export function hasWsRoute(url: URL): boolean {
  return registry().routes.some((r) => r.match(url));
}

/**
 * Perform the upgrade and hand the socket to its route.
 *
 * Returns false when no route matches, so the caller can let another listener
 * — Vite's HMR socket, for instance — have the request.
 */
export function handleWsUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const reg = registry();
  const route = reg.routes.find((r) => r.match(url));
  if (!route) return false;

  // `ws` reads the protocol selector off the server instance, and the registry
  // shares one server across routes, so it is set per upgrade.
  (reg.server as any).options.handleProtocols = route.selectProtocol
    ? (protocols: Set<string>) => route.selectProtocol!(protocols)
    : undefined;

  reg.server.handleUpgrade(request, socket, head, (ws) => {
    Promise.resolve()
      .then(() => route.handle(ws, request, url))
      .catch((e) => {
        console.error('[ws] handler failed:', e);
        try { ws.close(1011, 'Internal error'); } catch { /* already gone */ }
      });
  });

  return true;
}
