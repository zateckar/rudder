import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// In production the ORIGIN env var is set to the deployment URL and SvelteKit
// uses it automatically for CSRF checking via the `origin` option on the Node
// adapter.  We additionally enumerate trusted origins here so that local
// development (npm run dev) continues to work without needing ORIGIN set.
const devOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://localhost:7244'];

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
	},
};

export default config;
