declare module '*?raw' {
	const content: string;
	export default content;
}

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The session user, resolved once per request in hooks.server.ts.
			 *
			 * Null for an unauthenticated request and for one carrying only an API
			 * key. Read it through the helpers in $lib/server/auth rather than
			 * directly — they are what enforce the "not found, not forbidden"
			 * responses that stop endpoints doubling as id oracles.
			 *
			 * Before this existed, 56 route files re-derived identity for themselves
			 * with an inline `await import('$lib/auth')`, so a single page load
			 * validated the same session three times over.
			 */
			auth?: import('$lib/server/auth').AuthContext | null;
			userId?: string;
			userRole?: string;
			teamId?: string | null;
			apiUser?: boolean;
			/** Set when the request authenticated with an API key. Used for auditing. */
			apiKeyId?: string;
			apiKeyName?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
