import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// In production the ORIGIN env var is set to the deployment URL and SvelteKit
// uses it automatically for CSRF checking via the `origin` option on the Node
// adapter.  We additionally enumerate trusted origins here so that local
// development (npm run dev) continues to work without needing ORIGIN set.
// 7244 is the dev port, set in vite.config.ts with strictPort. 3000 covers a
// plain `node build`. 5173 was Vite's default and is kept only so an old
// bookmark or launch config does not fail a CSRF check with no explanation.
const devOrigins = [
	'http://localhost:7244',
	'http://127.0.0.1:7244',
	'http://localhost:3000',
	'http://127.0.0.1:3000',
	'http://localhost:5173',
];

const isProduction = process.env.NODE_ENV === 'production';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		csrf: {
			// In production only trust the configured ORIGIN; fall back to dev
			// origins when running locally without NODE_ENV=production.
			trustedOrigins: isProduction ? [] : devOrigins,
		},
		// Content-Security-Policy for rendered pages.
		//
		// This lives here rather than in hooks.server.ts because SvelteKit emits an
		// inline script per page to pass hydration data, and only SvelteKit can
		// nonce it. Setting the header by hand meant covering that script with
		// 'unsafe-inline', which allows *every* inline script — so an injected
		// string anywhere in the app would have executed. `mode: 'auto'` nonces
		// dynamically rendered pages and hashes prerendered ones, which is what
		// makes it possible to drop 'unsafe-inline' rather than work around it.
		//
		// hooks.server.ts still sets the other security headers, and a stricter
		// policy on responses that are not pages.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// No 'unsafe-eval'. Monaco's AMD loader probes for eval and falls
				// back to injecting script tags when it is unavailable, and xterm
				// does not use it at all — so the editor and the terminal both work
				// under this. blob: is for Monaco's web workers.
				'script-src': ['self', 'blob:'],
				// 'unsafe-inline' stays, and cannot reasonably go: both Monaco and
				// xterm build <style> elements at runtime without setting a nonce on
				// them. Inline style is a far narrower capability than inline script.
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['self', 'data:', 'https://fonts.gstatic.com'],
				'img-src': ['self', 'data:', 'blob:'],
				// 'self' covers same-origin ws:// and wss:// per CSP level 3, so the
				// terminal and kubectl exec sockets connect without the bare `ws:`
				// and `wss:` schemes that previously allowed a socket to *any* host.
				'connect-src': ['self'],
				'worker-src': ['self', 'blob:'],
				'object-src': ['none'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
			},
		},
	},
};

export default config;
