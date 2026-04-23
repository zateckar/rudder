import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, auditLogs } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSessionIdFromCookies, validateSession } from '$lib/auth';
import { v4 as uuid } from 'uuid';
import { initializeTerminalServer } from '$lib/server/terminal';
import { env } from '$env/dynamic/private';

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Basic security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-XSS-Protection', '1; mode=block');
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

  const response = await resolve(event);

  if (event.request.method !== 'GET' && event.request.method !== 'HEAD' && event.request.method !== 'OPTIONS') {
    if (userId) {
      const url = new URL(event.request.url);
      if (!url.pathname.startsWith('/api/auth/')) {
        let resourceType = 'unknown';
        let action = event.request.method;
        
        if (url.pathname.startsWith('/api/applications')) resourceType = 'application';
        else if (url.pathname.startsWith('/api/workers')) resourceType = 'worker';
        else if (url.pathname.startsWith('/api/containers')) resourceType = 'container';
        else if (url.pathname.startsWith('/api/teams')) resourceType = 'team';
        else if (url.pathname.startsWith('/api/domains')) resourceType = 'domain';

        try {
          await db.insert(auditLogs).values({
            id: uuid(),
            userId: userId || null,
            teamId: null,
            action,
            resourceType,
            details: JSON.stringify({
              path: url.pathname,
              status: response.status
            }),
            createdAt: new Date(),
          });
        } catch (e) {
          console.error('Failed to write audit log:', e);
        }
      }
    }
  }

  return response;
};

export const handle = sequence(securityHeaders, authentication);

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
