/**
 * Authorization for routes.
 *
 * Identity is resolved exactly once, in `hooks.server.ts`, and parked on
 * `event.locals.auth`. Everything here is a read of that plus whatever
 * resource-scoped lookup the caller needs — so `requireUser` and
 * `requireAdmin` are synchronous, and the async ones do one query for the
 * resource rather than three for the session.
 *
 * Before this, three mechanisms coexisted: `locals` (populated, read by ten
 * files), these helpers taking `cookies` (twenty-eight files), and an inline
 * `await import('$lib/auth')` with a hand-written role check (fifty-six files,
 * eighty-two occurrences — three times in one file in the worst case). They did
 * not disagree about *policy*; they disagreed about how many times to ask.
 *
 * ## The 404 rule
 *
 * A resource the caller may not see is reported as absent, not as forbidden.
 * `403` on an id that exists and `404` on one that does not turns any of these
 * endpoints into an oracle for enumerating other teams' applications and
 * containers. `requireApplication` and `requireContainer` both throw 404.
 */
import { json, redirect, type RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, teamMembers, applications, workers, teams, containers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { getSessionIdFromCookies, validateSession } from '$lib/auth';
import { ValidationError } from './validation';
import { PodmanApiError } from './podman';
import { podmanErrorResponse } from './podman-client';

export type UserRole = 'admin' | 'member';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  fullName: string;
}

export interface AuthContext {
  user: AuthUser;
  sessionUserId: string;
}

export class AuthorizationError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.statusCode = statusCode;
  }
}

/** Anything with `locals` — a `load`, a `+server.ts` handler, or a form action. */
type AuthEvent = { locals: App.Locals };

// ── Identity (no I/O — hooks.server.ts already did it) ───────────────────────

/** The session user, or null. */
export function currentUser(event: AuthEvent): AuthContext | null {
  return event.locals.auth ?? null;
}

export function requireUser(event: AuthEvent): AuthContext {
  const ctx = event.locals.auth;
  if (!ctx) throw new AuthorizationError('Authentication required', 401);
  return ctx;
}

export function requireAdminUser(event: AuthEvent): AuthContext {
  const ctx = requireUser(event);
  if (ctx.user.role !== 'admin') {
    throw new AuthorizationError('Admin access required', 403);
  }
  return ctx;
}

export function isAdmin(ctx: AuthContext | null): boolean {
  return ctx?.user.role === 'admin';
}

// ── Page loads ───────────────────────────────────────────────────────────────
//
// A `load` answers an unauthenticated caller with a redirect, not a 401, so
// these are separate from `requireUser` rather than a flag on it — a page that
// threw a 401 would render SvelteKit's error page instead of the login form.

/** The session user, or a redirect to the login page. */
export function requirePageUser(event: AuthEvent): AuthContext {
  const ctx = event.locals.auth;
  if (!ctx) throw redirect(303, '/login');
  return ctx;
}

/**
 * An admin, or a redirect.
 *
 * A signed-in member goes to the dashboard rather than the login form: they are
 * authenticated, so asking them to log in again would be a loop they cannot get
 * out of.
 */
export function requirePageAdmin(event: AuthEvent): AuthContext {
  const ctx = requirePageUser(event);
  if (ctx.user.role !== 'admin') throw redirect(303, '/dashboard');
  return ctx;
}

// ── Resource scoping ─────────────────────────────────────────────────────────

/**
 * A worker, for a caller allowed to manage it.
 *
 * Workers are admin-only across the whole product — the /workers pages, the
 * provisioning routes and every Podman passthrough. The order matters: the
 * role is checked before the worker is looked up, so a member cannot learn
 * whether an id exists.
 */
export async function requireWorker(
  event: AuthEvent,
  workerId: string,
): Promise<{ ctx: AuthContext; worker: typeof workers.$inferSelect }> {
  const ctx = requireAdminUser(event);

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) throw new AuthorizationError('Worker not found', 404);

  return { ctx, worker };
}

/** As `requireWorker`, but also refuses a worker with no Podman API configured. */
export async function requireWorkerWithApi(
  event: AuthEvent,
  workerId: string,
): Promise<{ ctx: AuthContext; worker: typeof workers.$inferSelect }> {
  const found = await requireWorker(event, workerId);
  if (!found.worker.podmanApiUrl) {
    throw new AuthorizationError(
      `Worker "${found.worker.name}" has no Podman API URL configured. Provision it first.`,
      409,
    );
  }
  return found;
}

/** An application the caller's teams own. 404 when they may not see it. */
export async function requireApplication(
  event: AuthEvent,
  applicationId: string,
): Promise<{ ctx: AuthContext; application: typeof applications.$inferSelect }> {
  const ctx = requireUser(event);

  const application = await db
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .get();
  if (!application) throw new AuthorizationError('Application not found', 404);

  if (ctx.user.role === 'admin') return { ctx, application };

  if (!application.teamId || !(await isTeamMember(ctx.user.id, application.teamId))) {
    throw new AuthorizationError('Application not found', 404);
  }

  return { ctx, application };
}

/**
 * A container the caller may act on, with the worker that hosts it.
 *
 * Containers inherit tenancy from the application that owns them. One with no
 * owning application is infrastructure, so only admins reach it.
 */
export async function requireContainer(
  event: AuthEvent,
  containerId: string,
): Promise<{
  ctx: AuthContext;
  container: typeof containers.$inferSelect;
  worker: typeof workers.$inferSelect;
}> {
  const ctx = requireUser(event);

  const container = await db.select().from(containers).where(eq(containers.id, containerId)).get();
  if (!container) throw new AuthorizationError('Container not found', 404);

  if (ctx.user.role !== 'admin') {
    if (!container.applicationId) throw new AuthorizationError('Container not found', 404);

    const application = await db
      .select({ teamId: applications.teamId })
      .from(applications)
      .where(eq(applications.id, container.applicationId))
      .get();

    if (!application?.teamId || !(await isTeamMember(ctx.user.id, application.teamId))) {
      throw new AuthorizationError('Container not found', 404);
    }
  }

  if (!container.workerId) {
    throw new AuthorizationError('Container has no worker assigned', 400);
  }
  const worker = await db.select().from(workers).where(eq(workers.id, container.workerId)).get();
  if (!worker) throw new AuthorizationError('Worker not found', 404);

  return { ctx, container, worker };
}

/** Like `requireContainer` but without resolving the worker. */
export async function requireContainerScoped(
  event: AuthEvent,
  containerId: string,
): Promise<{ ctx: AuthContext; container: typeof containers.$inferSelect }> {
  const { ctx, container } = await requireContainer(event, containerId);
  return { ctx, container };
}

/**
 * A caller who belongs to this team, or an admin.
 *
 * Teams are flat: there is no second tier inside one. This used to return a
 * `teamRole` and have a `requireTeamOwnership` sibling, and the difference
 * between them decided who could rename a team, delete a volume or mint an API
 * key. Those splits are gone — team *lifecycle* and *membership* are admin work
 * (`requireAdminUser`), and everything a team owns is open to every member of it.
 */
export async function requireTeam(event: AuthEvent, teamId: string): Promise<AuthContext> {
  const ctx = requireUser(event);
  if (ctx.user.role === 'admin') return ctx;

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ctx.user.id), eq(teamMembers.teamId, teamId)))
    .get();
  if (!membership) throw new AuthorizationError('Access denied to this team', 403);

  return ctx;
}

/** Every team the caller can see. Admins see all of them. */
export async function userTeams(event: AuthEvent): Promise<typeof teams.$inferSelect[]> {
  const ctx = currentUser(event);
  if (!ctx) return [];

  if (ctx.user.role === 'admin') return db.select().from(teams).all();

  const memberships = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, ctx.user.id))
    .all();

  return memberships.map((m) => m.team);
}

// ── Data-coherence rules (not caller permissions) ────────────────────────────

/**
 * Whether this caller may place a resource in `teamId`.
 *
 * Form actions name their owning team in the submitted body. The dropdown that
 * offers it is scoped to the caller's teams, but the field is not, so this is
 * what stands between "pick one of your teams" and "pick any team in the
 * installation" — the latter lets a stranger inject an application into another
 * team, where it consumes their quota, claims a domain and gets deployed on
 * their behalf.
 *
 * Returns a boolean rather than throwing because the callers are form actions
 * answering with `fail()`, not JSON endpoints.
 */
export async function canWriteToTeam(ctx: AuthContext, teamId: string): Promise<boolean> {
  if (ctx.user.role === 'admin') return true;
  return isTeamMember(ctx.user.id, teamId);
}

export async function isTeamMember(userId: string, teamId: string): Promise<boolean> {
  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
    .get();

  return !!membership;
}

// ── Route plumbing ───────────────────────────────────────────────────────────

/**
 * Convert an AuthorizationError into a JSON response. Re-throws anything else
 * so genuine faults still surface as 500s rather than being masked as 403s.
 */
export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return json({ error: error.message }, { status: error.statusCode });
  }
  throw error;
}

/**
 * Any event a route handler can receive. Deliberately loose in both parameters
 * so one wrapper serves every route: SvelteKit generates a `RequestHandler`
 * with the route's own `params` and `RouteId`, and those are assignable to
 * these.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RouteId is a
// generated union of every route in the app; `any` is what makes one wrapper
// assignable to all of them.
type AnyEvent = RequestEvent<Partial<Record<string, string>>, any>;

/**
 * Wrap a handler so the three error classes that are the *caller's* problem
 * answer with their own status instead of a 500.
 *
 * This is what lets a handler read as the operation it performs. The pattern it
 * replaces was four lines of try/catch per verb, repeated across every route,
 * and the repetition is why they drifted: 21 of the 22 files that talk to
 * Podman turned its refusals into `{ error: … }, { status: 500 }`, so "this
 * image is still used by a container" — a 409 the user can act on — reached
 * them as the control plane having fallen over.
 *
 * Anything else still throws, and still becomes a 500. That is the point: a
 * genuine fault must not be quietly relabelled as a client error.
 */
export function route(
  fn: (event: AnyEvent) => Promise<Response>,
): (event: AnyEvent) => Promise<Response> {
  return async (event) => {
    try {
      return await fn(event);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return json({ error: error.message }, { status: error.statusCode });
      }
      if (error instanceof ValidationError) {
        return json({ error: error.message }, { status: 400 });
      }
      if (error instanceof PodmanApiError) {
        return podmanErrorResponse(error);
      }
      throw error;
    }
  };
}

// ── Cookie-based adapters ────────────────────────────────────────────────────
//
// The pre-`locals` surface. These still re-validate the session, so they cost
// two queries a request that `requireUser` does not; they remain only for form
// actions and loads that have not been converted. Prefer the `event` variants.

export async function getAuthUser(cookies: Cookies): Promise<AuthContext | null> {
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) return null;

  const userId = await validateSession(sessionId);
  if (!userId) return null;

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return null;

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role as UserRole,
      fullName: user.fullName,
    },
    sessionUserId: userId,
  };
}

export async function requireAuth(cookies: Cookies): Promise<AuthContext> {
  const ctx = await getAuthUser(cookies);
  if (!ctx) throw new AuthorizationError('Authentication required', 401);
  return ctx;
}

export async function canAccessApplication(
  cookies: Cookies,
  applicationId: string,
): Promise<{ ctx: AuthContext; application: typeof applications.$inferSelect } | null> {
  const ctx = await getAuthUser(cookies);
  if (!ctx) return null;

  const application = await db
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .get();
  if (!application) return null;

  if (ctx.user.role === 'admin') return { ctx, application };
  if (!application.teamId) return null;
  if (!(await isTeamMember(ctx.user.id, application.teamId))) return null;

  return { ctx, application };
}

export async function getUserTeams(cookies: Cookies): Promise<typeof teams.$inferSelect[]> {
  const ctx = await getAuthUser(cookies);
  if (!ctx) return [];

  if (ctx.user.role === 'admin') return db.select().from(teams).all();

  const memberships = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, ctx.user.id))
    .all();

  return memberships.map((m) => m.team);
}
