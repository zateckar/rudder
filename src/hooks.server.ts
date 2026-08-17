import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, auditLogs, apiKeys } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSessionIdFromCookies, validateSession } from '$lib/auth';
import { classifyRequest, isAuditable } from '$lib/server/audit';
import { env } from '$env/dynamic/private';
import { hashKey } from '$lib/server/encryption';

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Basic security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
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
  // Monaco Editor and xterm.js require 'unsafe-eval' and 'unsafe-inline'.
  // blob: is needed for Monaco worker scripts.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', csp);

  return response;
};

/**
 * How stale `lastUsedAt` is allowed to get.
 *
 * This column answers "is this key still in use, and roughly when last?" — a
 * question nobody asks to the second. Writing it on every authenticated request
 * put a database write in front of every `kubectl` call, including the reads,
 * which is the hot path for the Kubernetes-compatible API.
 */
const API_KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Record that a key was used, at most once per interval. */
async function touchApiKey(id: string, lastUsedAt: Date | null): Promise<void> {
  const now = new Date();
  if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < API_KEY_TOUCH_INTERVAL_MS) {
    return;
  }
  try {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id));
  } catch (e) {
    // Never fail a request because we could not record its timestamp.
    console.error('[auth] Could not update API key lastUsedAt:', e);
  }
}

const authentication: Handle = async ({ event, resolve }) => {
  let userId: string | null = null;
  let teamId: string | null = null;
  
  const sessionId = getSessionIdFromCookies(event.cookies);
  if (sessionId) {
    userId = await validateSession(sessionId);
    if (userId) {
      event.locals.userId = userId;
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (user) {
        event.locals.userRole = user.role;
      }
    }
  }

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
