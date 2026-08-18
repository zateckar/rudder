import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, teamMembers, applications, workers, teams, containers, stacks } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { getSessionIdFromCookies, validateSession } from '$lib/auth';

export type UserRole = 'admin' | 'member';
export type TeamRole = 'owner' | 'member';

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
  if (!ctx) {
    throw new AuthorizationError('Authentication required', 401);
  }
  return ctx;
}

export async function requireAdmin(cookies: Cookies): Promise<AuthContext> {
  const ctx = await requireAuth(cookies);
  if (ctx.user.role !== 'admin') {
    throw new AuthorizationError('Admin access required', 403);
  }
  return ctx;
}

export async function requireTeamMember(
  cookies: Cookies,
  teamId: string
): Promise<AuthContext & { teamRole: TeamRole }> {
  const ctx = await requireAuth(cookies);

  if (ctx.user.role === 'admin') {
    return { ...ctx, teamRole: 'owner' };
  }

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ctx.user.id), eq(teamMembers.teamId, teamId)))
    .get();

  if (!membership) {
    throw new AuthorizationError('Access denied to this team', 403);
  }

  return { ...ctx, teamRole: membership.role as TeamRole };
}

export async function requireTeamOwner(
  cookies: Cookies,
  teamId: string
): Promise<AuthContext> {
  const ctx = await requireAuth(cookies);

  if (ctx.user.role === 'admin') {
    return ctx;
  }

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ctx.user.id), eq(teamMembers.teamId, teamId)))
    .get();

  if (!membership || membership.role !== 'owner') {
    throw new AuthorizationError('Team owner access required', 403);
  }

  return ctx;
}

export async function canAccessApplication(
  cookies: Cookies,
  applicationId: string
): Promise<{ ctx: AuthContext; application: typeof applications.$inferSelect } | null> {
  const ctx = await getAuthUser(cookies);
  if (!ctx) return null;

  const application = await db
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .get();

  if (!application) return null;

  if (ctx.user.role === 'admin') {
    return { ctx, application };
  }

  if (!application.teamId) return null;

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ctx.user.id), eq(teamMembers.teamId, application.teamId)))
    .get();

  if (!membership) return null;

  return { ctx, application };
}

/**
 * Whether this caller may place a resource in `teamId`.
 *
 * Form actions name their owning team in the submitted body.  The dropdown that
 * offers it is scoped to the caller's teams, but the field is not, so this is what
 * stands between "pick one of your teams" and "pick any team in the
 * installation" — the latter lets a stranger inject an application into another
 * team, where it consumes their quota, claims a domain and gets deployed on their
 * behalf.
 *
 * Returns a boolean rather than throwing because the callers are form actions
 * answering with `fail()`, not JSON endpoints.
 */
export async function canWriteToTeam(ctx: AuthContext, teamId: string): Promise<boolean> {
  if (ctx.user.role === 'admin') return true;
  return isTeamMember(ctx.user.id, teamId);
}

/**
 * Whether `stackId` is a stack that may hold an application owned by `teamId`.
 *
 * A stack is scoped to its own team everywhere else — `/api/stacks/[id]` lists
 * every application in it and deploys, stops and restarts them in bulk.  So an
 * application sitting in another team's stack hands that team control of it,
 * which is why this is required of admins too and not only of members: it is a
 * coherence rule about the data, not a permission check on the caller.
 */
export async function stackAcceptsTeam(stackId: string, teamId: string | null): Promise<boolean> {
  if (!teamId) return false;
  const stack = await db
    .select({ teamId: stacks.teamId })
    .from(stacks)
    .where(eq(stacks.id, stackId))
    .get();
  return !!stack && stack.teamId === teamId;
}

export async function canAccessWorker(
  cookies: Cookies,
  workerId: string
): Promise<{ ctx: AuthContext; worker: typeof workers.$inferSelect } | null> {
  const ctx = await getAuthUser(cookies);
  if (!ctx) return null;

  const worker = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .get();

  if (!worker) return null;

  if (ctx.user.role === 'admin') {
    return { ctx, worker };
  }

  return null;
}

export async function canManageWorker(
  cookies: Cookies,
  workerId: string
): Promise<{ ctx: AuthContext; worker: typeof workers.$inferSelect }> {
  const ctx = await requireAuth(cookies);

  const worker = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .get();

  if (!worker) {
    throw new AuthorizationError('Worker not found', 404);
  }

  if (ctx.user.role !== 'admin') {
    throw new AuthorizationError('Admin access required to manage workers', 403);
  }

  return { ctx, worker };
}

/**
 * Resolve a container the caller is allowed to touch, together with its worker.
 *
 * Containers inherit their tenancy from the application that owns them.  A
 * container with no owning application (e.g. discovered directly on a worker)
 * is infrastructure, so only admins may reach it.
 *
 * Throws AuthorizationError so callers can funnel failures through
 * `authErrorResponse`.  404 is returned for containers the caller may not see
 * so the endpoint does not double as a container-ID oracle.
 */
export async function requireContainerScope(
  cookies: Cookies,
  containerId: string
): Promise<{
  ctx: AuthContext;
  container: typeof containers.$inferSelect;
}> {
  const ctx = await requireAuth(cookies);

  const container = await db
    .select()
    .from(containers)
    .where(eq(containers.id, containerId))
    .get();

  if (!container) {
    throw new AuthorizationError('Container not found', 404);
  }

  if (ctx.user.role !== 'admin') {
    if (!container.applicationId) {
      throw new AuthorizationError('Container not found', 404);
    }

    const application = await db
      .select()
      .from(applications)
      .where(eq(applications.id, container.applicationId))
      .get();

    if (!application?.teamId) {
      throw new AuthorizationError('Container not found', 404);
    }

    const membership = await db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.userId, ctx.user.id),
          eq(teamMembers.teamId, application.teamId)
        )
      )
      .get();

    if (!membership) {
      throw new AuthorizationError('Container not found', 404);
    }
  }

  return { ctx, container };
}

/**
 * As `requireContainerScope`, but also resolves the worker that hosts the
 * container.  Use this for any route that talks to the Podman API.
 */
export async function requireContainerAccess(
  cookies: Cookies,
  containerId: string
): Promise<{
  ctx: AuthContext;
  container: typeof containers.$inferSelect;
  worker: typeof workers.$inferSelect;
}> {
  const { ctx, container } = await requireContainerScope(cookies, containerId);

  if (!container.workerId) {
    throw new AuthorizationError('Container has no worker assigned', 400);
  }

  const worker = await db
    .select()
    .from(workers)
    .where(eq(workers.id, container.workerId))
    .get();

  if (!worker) {
    throw new AuthorizationError('Worker not found', 404);
  }

  return { ctx, container, worker };
}

/**
 * Convert an AuthorizationError into a JSON response.  Re-throws anything else
 * so genuine faults still surface as 500s rather than being masked as 403s.
 */
export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return json({ error: error.message }, { status: error.statusCode });
  }
  throw error;
}

export async function getUserTeams(cookies: Cookies): Promise<typeof teams.$inferSelect[]> {
  const ctx = await getAuthUser(cookies);
  if (!ctx) return [];

  if (ctx.user.role === 'admin') {
    return db.select().from(teams).all();
  }

  const memberships = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, ctx.user.id))
    .all();

  return memberships.map(m => m.team);
}

export async function isTeamMember(userId: string, teamId: string): Promise<boolean> {
  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
    .get();

  return !!membership;
}

export function isAdmin(ctx: AuthContext | null): boolean {
  return ctx?.user.role === 'admin';
}

export function canPerformAction(
  ctx: AuthContext,
  action: 'create' | 'read' | 'update' | 'delete',
  resource: 'worker' | 'user' | 'team' | 'application' | 'secret' | 'settings'
): boolean {
  if (ctx.user.role === 'admin') return true;

  switch (resource) {
    case 'worker':
    case 'user':
    case 'settings':
      return false;
    case 'team':
    case 'application':
    case 'secret':
      return true;
    default:
      return false;
  }
}
