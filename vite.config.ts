import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type PluginOption, type ViteDevServer } from 'vite';
import { readFileSync } from 'fs';

/**
 * Serve WebSocket upgrades in dev and preview.
 *
 * SvelteKit does not handle upgrades, so `+server.ts` cannot answer one; the
 * app registers its handlers in a global registry and the HTTP server
 * dispatches to them. This is the dev-server half of that; `server.js` is the
 * production half. Without both, the container terminal and `kubectl exec`
 * connect and then hang.
 */
function websocketPlugin(): PluginOption {
  const attach = async (server: ViteDevServer) => {
    if (!server.httpServer) return;

    server.httpServer.on('upgrade', async (request, socket, head) => {
      // Vite's own HMR socket comes through here too. Load the app's handlers
      // and let the registry decide; anything it does not claim is left for
      // Vite's listener, which runs independently on the same event.
      try {
        // Loading hooks.server.ts through Vite gives the handlers the same
        // module instances the request path uses, aliases and all.
        await server.ssrLoadModule('/src/hooks.server.ts');
        const { handleWsUpgrade } = await server.ssrLoadModule(
          '/src/lib/server/ws/registry.ts',
        );
        handleWsUpgrade(request, socket, head);
      } catch (e) {
        console.error('[ws] upgrade failed:', e);
        socket.destroy();
      }
    });
  };

  return {
    name: 'rudder-websockets',
    configureServer: attach,
    configurePreviewServer: attach as any,
  };
}

/**
 * Optional TLS for the dev server.
 *
 * kubectl refuses to send a bearer token over plaintext HTTP, so the
 * Kubernetes-compatible API — and `kubectl exec` in particular — cannot be
 * exercised against `http://localhost`. Point DEV_TLS_KEY and DEV_TLS_CERT at
 * a self-signed pair and connect with `--insecure-skip-tls-verify`.
 */
function devTls() {
	const key = process.env.DEV_TLS_KEY;
	const cert = process.env.DEV_TLS_CERT;
	if (!key || !cert) return undefined;
	return { key: readFileSync(key), cert: readFileSync(cert) };
}

export default defineConfig({
	plugins: [sveltekit(), websocketPlugin()],
	server: {
		port: 7244,
		strictPort: true,
		host: '0.0.0.0',
		https: devTls()
	}
});
