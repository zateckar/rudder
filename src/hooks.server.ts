import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, auditLogs, apiKeys } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSessionIdFromCookies, validateSession } from '$lib/auth';
import { classifyRequest, isAuditable } from '$lib/server/audit';
import { touchApiKey } from '$lib/server/api-keys';
import { env } from '$env/dynamic/private';
import { hashKey } from '$lib/server/encryption';

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Basic security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // DENY, to agree with `frame-ancestors 'none'` in the CSP below rather than
  // contradict it. Modern browsers take frame-ancestors and ignore this header;
  // the two disagreeing only mattered to whoever read them next.
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // X-XSS-Protection is deliberately not set: the legacy auditor it enables is
  // removed from current browsers and could itself introduce vulnerabilities.
  // The CSP below is the actual defence.
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // HSTS: only set in production to avoid breaking local dev (HTTP)
  if (env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Content-Security-Policy
  //
  // Pages get theirs from SvelteKit, which is the only thing that can put a
  // nonce on the inline hydration script it emits — see the `csp` block in
  // svelte.config.js. Setting it here as well would overwrite that nonce and
  // break every page, so this only fills in the responses SvelteKit does not
  // cover: API JSON, the Monaco assets, anything else that is not a rendered
  // page. None of those load subresources, so they get a policy that permits
  // nothing at all.
  if (!response.headers.has('Content-Security-Policy')) {
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  }

  return response;
};

const authentication: Handle = async ({ event, resolve }) => {
  let userId: string | null = null;

  // Resolved once, here, and read from `locals` everywhere downstream.
  //
  // This used to set `locals.userId` and `locals.userRole` and stop there, and
  // almost nothing read them: 56 route files instead re-ran this same session
  // validation and user lookup for themselves via an inline
  // `await import('$lib/auth')`. A single application page load performed three
  // session validations and three user reads as a result. `locals.auth` now
  // carries the whole context so the helpers in $lib/server/auth are pure
  // reads.
  const sessionId = getSessionIdFromCookies(event.cookies);
  if (sessionId) {
    userId = await validateSession(sessionId);
    if (userId) {
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (user) {
        event.locals.userId = userId;
        event.locals.userRole = user.role;
        event.locals.auth = {
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role as 'admin' | 'member',
            fullName: user.fullName,
          },
          sessionUserId: userId,
        };
      } else {
        // A session pointing at a user that no longer exists is not a session.
        userId = null;
      }
    }
  }
  event.locals.auth ??= null;

  // Bearer token auth via API keys (for K8s-compatible API and programmatic access)
  if (!userId) {
    const authHeader = event.request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        try {
          const keyHash = hashKey(token);
          const apiKey = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
          if (apiKey && (!apiKey.expiresAt || apiKey.expiresAt > new Date())) {
            event.locals.apiUser = true;
            event.locals.teamId = apiKey.teamId;
            event.locals.apiKeyId = apiKey.id;
            event.locals.apiKeyName = apiKey.name;
            await touchApiKey(apiKey.id, apiKey.lastUsedAt);
          }
        } catch (e) {
          console.error('Bearer auth error:', e);
        }
      }
    }
  }

  const response = await resolve(event);

  // Audit every mutating request that carried *some* identity — session or API
  // key.  Previously only session users were recorded, so the entire
  // kubectl/API-key surface mutated state with no trail at all.
  const isMutation =
    event.request.method !== 'GET' &&
    event.request.method !== 'HEAD' &&
    event.request.method !== 'OPTIONS';

  if (isMutation && (userId || event.locals.apiUser)) {
    const url = new URL(event.request.url);
    if (isAuditable(url.pathname)) {
      // What was done, not which HTTP verb carried it — see classifyRequest.
      const { action, resourceType, resourceId } = classifyRequest(
        event.request.method,
        url.pathname,
        url.search,
      );

      try {
        await db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          userId: userId ?? null,
          teamId: event.locals.teamId ?? null,
          action,
          resourceType,
          resourceId,
          details: JSON.stringify({
            method: event.request.method,
            path: url.pathname,
            status: response.status,
            // Identify the actor when there is no user behind the request.
            ...(event.locals.apiUser
              ? { via: 'api_key', apiKeyId: event.locals.apiKeyId, apiKeyName: event.locals.apiKeyName }
              : {}),
          }),
          createdAt: new Date(),
        });
      } catch (e) {
        console.error('Failed to write audit log:', e);
      }
    }
  }

  return response;
};

export const handle = sequence(securityHeaders, authentication);

// ── WebSocket routes ─────────────────────────────────────────────────────────
// Registered from inside the app so the handlers share its database connection
// and Podman clients; the HTTP server (Vite in dev, server.js in production)
// only dispatches upgrades to them. SvelteKit itself does not serve upgrades —
// see src/lib/server/ws/registry.ts.
import '$lib/server/ws/handlers';

// ── Background metrics collection ────────────────────────────────────────────
// Guard against re-initialization (e.g. HMR hot reloads in dev)
if (!(globalThis as any).__metricsStarted) {
  (globalThis as any).__metricsStarted = true;
  import('$lib/server/metrics')
    .then(({ startMetricsCollection }) => startMetricsCollection())
    .catch((e) => console.error('[metrics] Failed to start collection:', e));
}

// ── Backup scheduler ─────────────────────────────────────────────────────────
if (!(globalThis as any).__backupStarted) {
  (globalThis as any).__backupStarted = true;
  import('$lib/server/backup')
    .then(({ startBackupScheduler }) => startBackupScheduler())
    .catch((e) => console.error('[backup] Failed to start scheduler:', e));
}

export const handleFetch = async ({ request, fetch }: { request: Request; fetch: typeof global.fetch }) => {
  return fetch(request);
};
