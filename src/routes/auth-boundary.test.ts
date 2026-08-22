/**
 * Who can reach what.
 *
 * Every defect in the 2026-08-17 run that mattered was of this shape: a page or
 * an endpoint that authenticated the caller and then forgot to check what they
 * were allowed to see. The dashboard returned the global audit log to a member,
 * `/settings/notifications` answered 200 to anyone with a session, and
 * `/api/users` accepted a five-character password. None of it was caught,
 * because nothing tested a route handler at all.
 *
 * These run against a throwaway SQLite file (see test/preload.ts) and call the
 * handlers directly, so they are as fast as the unit tests around them and do
 * not need a server, a browser or a worker.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Cookies } from '@sveltejs/kit';
import { db } from '$lib/db';
import {
  alertEvents,
  alertRules,
  apiKeys,
  applicationTemplates,
  applications,
  auditLogs,
  deployments,
  notificationChannels,
  secrets,
  stacks,
  teamMembers,
  teamQuotas,
  teams,
  users,
  volumes,
} from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { createSession, hashPassword } from '$lib/auth';
import { consume, reset } from '$lib/server/rate-limit';

/** A Cookies stand-in holding one session cookie. */
function cookiesFor(sessionId: string | null): Cookies {
  return {
    get: (name: string) => (name === 'session_id' && sessionId ? sessionId : undefined),
    getAll: () => [],
    set: () => {},
    delete: () => {},
    serialize: () => '',
  } as unknown as Cookies;
}

interface Actor {
  id: string;
  cookies: Cookies;
}

async function makeUser(username: string, role: 'admin' | 'member'): Promise<Actor> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id,
    username,
    email: `${username}@example.test`,
    passwordHash: await hashPassword('correct-horse-battery'),
    fullName: username,
    role,
    createdAt: now,
    updatedAt: now,
  });
  return { id, cookies: cookiesFor(await createSession(id)) };
}

let admin: Actor;
let member: Actor;
/** A member of no team at all — the case that leaked the whole audit log. */
let loner: Actor;
let anonymous: Cookies;
let teamId: string;
/** A team the member does not belong to, to have something to leak. */
let otherTeamId: string;
/** Resources owned by `otherTeamId` — what a cross-team caller must not reach. */
let otherAppId: string;
let otherStackId: string;
let otherVolumeId: string;
let otherDeploymentId: string;
/** A volume with no owning team, the case the `&& volume.teamId` guard skipped. */
let orphanVolumeId: string;

beforeAll(async () => {
  admin = await makeUser('boundary-admin', 'admin');
  member = await makeUser('boundary-member', 'member');
  loner = await makeUser('boundary-loner', 'member');
  anonymous = cookiesFor(null);

  teamId = crypto.randomUUID();
  const now = new Date();
  await db.insert(teams).values({
    id: teamId,
    name: 'Boundary Team',
    slug: 'boundary-team',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(teamMembers).values({ teamId, userId: member.id, role: 'member', joinedAt: now });

  otherTeamId = crypto.randomUUID();
  await db.insert(teams).values({
    id: otherTeamId,
    name: 'Other Team',
    slug: 'other-team',
    createdAt: now,
    updatedAt: now,
  });

  // Resources belonging to the team the member is not in. Every cross-team test
  // below reads or writes one of these; without them the assertions would pass
  // against an empty database.
  otherAppId = crypto.randomUUID();
  await db.insert(applications).values({
    id: otherAppId,
    name: 'other-team-app',
    teamId: otherTeamId,
    type: 'single',
    deploymentFormat: 'compose',
    manifest: 'image: nginx:1.27',
    environment: JSON.stringify({ DB_PASSWORD: 'not-yours' }),
    restartPolicy: 'always',
    createdAt: now,
    updatedAt: now,
  });

  otherStackId = crypto.randomUUID();
  await db.insert(stacks).values({
    id: otherStackId,
    name: 'other-team-stack',
    teamId: otherTeamId,
    createdBy: admin.id,
    createdAt: now,
    updatedAt: now,
  });

  otherVolumeId = crypto.randomUUID();
  await db.insert(volumes).values({
    id: otherVolumeId,
    name: 'other-team-volume',
    teamId: otherTeamId,
    containerPath: '/data',
    createdAt: now,
    updatedAt: now,
  });

  orphanVolumeId = crypto.randomUUID();
  await db.insert(volumes).values({
    id: orphanVolumeId,
    name: 'orphan-volume',
    teamId: null,
    containerPath: '/data',
    createdAt: now,
    updatedAt: now,
  });

  otherDeploymentId = crypto.randomUUID();
  await db.insert(deployments).values({
    id: otherDeploymentId,
    applicationId: otherAppId,
    version: 1,
    manifest: 'image: nginx:1.26',
    image: 'nginx:1.26',
    status: 'succeeded',
    deployedBy: admin.id,
    createdAt: now,
    finishedAt: now,
  });

  // Three audit entries the dashboard has to choose between: one the member
  // owns, one belonging to a team they are not in, and one installation-wide
  // (no team, written by the admin). Without all three the scoping assertion
  // below has nothing to detect — an empty log satisfies any filter.
  await db.insert(auditLogs).values([
    {
      id: crypto.randomUUID(),
      userId: member.id,
      teamId,
      action: 'DEPLOY',
      resourceType: 'application',
      resourceId: 'own-team-entry',
      details: '{}',
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      userId: admin.id,
      teamId: otherTeamId,
      action: 'DEPLOY',
      resourceType: 'application',
      resourceId: 'other-team-entry',
      details: '{}',
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      userId: admin.id,
      teamId: null,
      action: 'CREATE',
      resourceType: 'user',
      resourceId: 'installation-wide-entry',
      details: '{}',
      createdAt: now,
    },
  ]);
});

/** The shape SvelteKit's `redirect()` throws. */
function isRedirect(thrown: unknown): thrown is { status: number; location: string } {
  return typeof thrown === 'object' && thrown !== null && 'status' in thrown && 'location' in thrown;
}

/** Run a page load and report where it sent the caller, if anywhere. */
async function loadRedirect(
  load: (event: any) => unknown,
  event: any,
): Promise<string | null> {
  try {
    await load(event);
    return null;
  } catch (thrown) {
    if (isRedirect(thrown)) return thrown.location;
    throw thrown;
  }
}

describe('admin-only pages', () => {
  // The page that was 200 for members while every sibling redirected.
  const PAGES = [
    'settings/notifications',
    'settings/audit',
  ] as const;

  for (const page of PAGES) {
    test(`/${page} redirects a member`, async () => {
      const { load } = await import(`./${page}/+page.server.ts`);
      const event = { cookies: member.cookies, url: new URL('http://localhost/') };
      expect(await loadRedirect(load, event)).toBe('/dashboard');
    });

    test(`/${page} redirects an anonymous caller to the login page`, async () => {
      const { load } = await import(`./${page}/+page.server.ts`);
      const event = { cookies: anonymous, url: new URL('http://localhost/') };
      expect(await loadRedirect(load, event)).toBe('/login');
    });

    test(`/${page} lets an admin through`, async () => {
      const { load } = await import(`./${page}/+page.server.ts`);
      const event = { cookies: admin.cookies, url: new URL('http://localhost/') };
      expect(await loadRedirect(load, event)).toBeNull();
    });
  }
});

describe('dashboard scoping', () => {
  async function dashboard(actor: Actor) {
    const { load } = await import('./dashboard/+page.server.ts');
    return (await load({ cookies: actor.cookies, url: new URL('http://localhost/dashboard') })) as any;
  }

  test('a member with no teams is shown nothing at all', async () => {
    // The original defect: this returned the ten most recent audit entries
    // system-wide, every worker, and another team's deployments.
    const data = await dashboard(loner);

    expect(data.recentActivity).toEqual([]);
    expect(data.recentDeployments).toEqual([]);
    expect(data.applications).toEqual([]);
    expect(data.containers).toEqual([]);
    expect(data.teams).toEqual([]);
    expect(data.workers).toEqual([]);
    expect(data.containerStatusBreakdown).toEqual({});
    expect(data.workerResources).toEqual([]);
  });

  test('a member sees their own team and no audit log beyond it', async () => {
    const data = await dashboard(member);

    expect(data.teams.map((t: any) => t.id)).toEqual([teamId]);
    // The load does not select teamId, so entries are identified by the
    // resource they name. Exactly the one this team wrote: another team's entry
    // and the installation-wide one (which carries no team at all) must not
    // appear. Dropping the team filter from the load brings both back and fails
    // this line.
    expect(data.recentActivity.map((e: any) => e.resourceId)).toEqual(['own-team-entry']);
  });

  test('an admin sees the entries a member is denied', async () => {
    // Also proves the fixture above is reachable, so the assertion in the
    // previous test is not passing because nothing was written at all.
    const ids = (await dashboard(admin)).recentActivity.map((e: any) => e.resourceId);

    expect(ids).toContain('own-team-entry');
    expect(ids).toContain('other-team-entry');
    expect(ids).toContain('installation-wide-entry');
  });

  test('worker resource figures stay admin-only', async () => {
    expect((await dashboard(member)).workerResources).toEqual([]);
    // And an admin still gets the global view rather than an empty one.
    expect((await dashboard(admin)).teams.length).toBeGreaterThan(0);
  });
});

describe('admin-only APIs', () => {
  const ENDPOINTS = [
    { path: './api/users/+server.ts', method: 'GET' },
    { path: './api/notifications/+server.ts', method: 'GET' },
    { path: './api/alerts/+server.ts', method: 'GET' },
    { path: './api/alerts/events/+server.ts', method: 'GET' },
  ] as const;

  for (const { path, method } of ENDPOINTS) {
    test(`${path} ${method} refuses a member`, async () => {
      const handlers = await import(path);
      const response = await handlers[method]({
        cookies: member.cookies,
        url: new URL('http://localhost/'),
        request: new Request('http://localhost/'),
      } as any);
      expect(response.status).toBe(403);
    });

    test(`${path} ${method} refuses an anonymous caller`, async () => {
      const handlers = await import(path);
      const response = await handlers[method]({
        cookies: anonymous,
        url: new URL('http://localhost/'),
        request: new Request('http://localhost/'),
      } as any);
      expect(response.status).toBe(401);
    });

    test(`${path} ${method} answers an admin`, async () => {
      const handlers = await import(path);
      const response = await handlers[method]({
        cookies: admin.cookies,
        url: new URL('http://localhost/'),
        request: new Request('http://localhost/'),
      } as any);
      expect(response.status).toBe(200);
    });
  }

  test('a member cannot create a global notification channel', async () => {
    // The membership check only fired when a teamId was supplied, so omitting
    // it created a channel the whole installation notifies through.
    const { POST } = await import('./api/notifications/+server.ts');
    const response = await POST({
      cookies: member.cookies,
      request: new Request('http://localhost/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sneaky', type: 'webhook', config: { url: 'https://example.test' } }),
      }),
    } as any);

    expect(response.status).toBe(403);
  });

  test('a member cannot create a fleet-wide alert rule', async () => {
    const { POST } = await import('./api/alerts/+server.ts');
    const response = await POST({
      cookies: member.cookies,
      request: new Request('http://localhost/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sneaky', resourceType: 'worker', metric: 'cpu_percent', threshold: 1 }),
      }),
    } as any);

    expect(response.status).toBe(403);
  });
});

/**
 * Reaching another team's resources.
 *
 * These five routes authenticated the caller and then looked the resource up by
 * id alone, so a member of any team could read and act on every other team's
 * applications, stacks, deploy history and volumes. Each test names the route and
 * the thing it used to hand over.
 */
describe('cross-team resource access', () => {
  const jsonRequest = (url: string, method: string, body?: unknown) =>
    new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('a member cannot read another team\'s stack', async () => {
    // Returned every application row in the stack, spread whole — including the
    // plaintext `environment` column.
    const { GET } = await import('./api/stacks/[id]/+server.ts');
    const response = await GET({
      params: { id: otherStackId },
      cookies: member.cookies,
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot deploy, stop or restart another team\'s stack', async () => {
    // The cross-team denial of service: this ran the action against every
    // application in the stack.
    const { POST } = await import('./api/stacks/[id]/+server.ts');
    const response = await POST({
      params: { id: otherStackId },
      cookies: member.cookies,
      request: jsonRequest('http://localhost/api/stacks/x', 'POST', { action: 'stop' }),
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot delete another team\'s stack', async () => {
    const { DELETE } = await import('./api/stacks/[id]/+server.ts');
    const response = await DELETE({
      params: { id: otherStackId },
      cookies: member.cookies,
    } as any);

    expect(response.status).toBe(404);
    // And the stack is still there.
    const still = await db.select().from(stacks).where(eq(stacks.id, otherStackId)).get();
    expect(still).toBeTruthy();
  });

  test('a stack owner cannot detach an application from a different stack', async () => {
    // `removeAppId` was keyed on the application id alone, so it reached any
    // application in the installation regardless of which stack it was in.
    const { PATCH } = await import('./api/stacks/[id]/+server.ts');
    const response = await PATCH({
      params: { id: otherStackId },
      cookies: admin.cookies,
      request: jsonRequest('http://localhost/api/stacks/x', 'PATCH', { removeAppId: otherAppId }),
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot read another team\'s deploy history', async () => {
    const { GET } = await import('./api/applications/[id]/deployments/+server.ts');
    const response = await GET({
      params: { id: otherAppId },
      cookies: member.cookies,
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot roll back another team\'s application', async () => {
    // The rollback overwrote the application's manifest, environment and volumes
    // before the deploy call it delegated to could refuse.
    const { POST } = await import('./api/applications/[id]/deployments/+server.ts');
    const response = await POST({
      params: { id: otherAppId },
      cookies: member.cookies,
      request: jsonRequest('http://localhost/api/applications/x/deployments', 'POST', {
        deploymentId: otherDeploymentId,
      }),
    } as any);

    expect(response.status).toBe(404);
    // The manifest is untouched — the check has to happen before the write.
    const app = await db.select().from(applications).where(eq(applications.id, otherAppId)).get();
    expect(app?.manifest).toBe('image: nginx:1.27');
  });

  test('a member cannot snapshot another team\'s application as a template', async () => {
    const { POST } = await import('./api/templates/save/+server.ts');
    const form = new FormData();
    form.set('appId', otherAppId);
    form.set('name', 'stolen-template');
    const response = await POST({
      cookies: member.cookies,
      request: new Request('http://localhost/api/templates/save', { method: 'POST', body: form }),
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot open another team\'s application for editing', async () => {
    const { load } = await import('./applications/[id]/edit/+page.server.ts');
    expect(
      await loadRedirect(load, { params: { id: otherAppId }, cookies: member.cookies }),
    ).toBe('/applications');
  });

  test('a member cannot read or delete another team\'s volume', async () => {
    // 404, not 403: a 403 would confirm the id names a real volume in some team
    // the caller is not in. Same rule as /api/stacks/[id].
    const { GET, DELETE } = await import('./api/volumes/[id]/+server.ts');
    const event = { params: { id: otherVolumeId }, cookies: member.cookies } as any;

    expect((await GET(event)).status).toBe(404);
    expect((await DELETE(event)).status).toBe(404);
  });

  test('a plain member of the owning team is told they need the owner role', async () => {
    // The one case where 403 says something true and useful: the volume is
    // readable, so hiding its existence would be theatre — what is missing is the
    // role, and the message says so.
    const ownVolumeId = crypto.randomUUID();
    const now = new Date();
    await db.insert(volumes).values({
      id: ownVolumeId,
      name: 'own-team-volume',
      teamId,
      containerPath: '/data',
      createdAt: now,
      updatedAt: now,
    });

    const { GET, DELETE } = await import('./api/volumes/[id]/+server.ts');
    const event = { params: { id: ownVolumeId }, cookies: member.cookies } as any;

    expect((await GET(event)).status).toBe(200);
    expect((await DELETE(event)).status).toBe(403);
  });

  test('a teamless volume is admin-only, not everyone\'s', async () => {
    // `role !== 'admin' && volume.teamId` skipped the membership check entirely
    // when there was no team to check against.
    const { GET, DELETE } = await import('./api/volumes/[id]/+server.ts');
    const event = { params: { id: orphanVolumeId }, cookies: member.cookies } as any;

    expect((await GET(event)).status).toBe(404);
    expect((await DELETE(event)).status).toBe(404);
    // Still there, and an admin can still reach it.
    expect((await GET({ params: { id: orphanVolumeId }, cookies: admin.cookies } as any)).status).toBe(200);
  });

  test('a volume cannot be created without an owning team', async () => {
    const { POST } = await import('./api/volumes/+server.ts');
    const response = await POST({
      cookies: member.cookies,
      request: jsonRequest('http://localhost/api/volumes', 'POST', {
        name: 'no-team',
        containerPath: '/data',
      }),
    } as any);

    expect(response.status).toBe(400);
  });

  test('a member cannot create a volume for a team they are not in', async () => {
    const { POST } = await import('./api/volumes/+server.ts');
    const response = await POST({
      cookies: member.cookies,
      request: jsonRequest('http://localhost/api/volumes', 'POST', {
        name: 'not-mine',
        containerPath: '/data',
        teamId: otherTeamId,
      }),
    } as any);

    expect(response.status).toBe(403);
  });

  test('a member cannot create an application inside another team', async () => {
    // The edit action's mirror image. The New Application loader scopes the team
    // dropdown to the caller's teams, but the action read the submitted field, so
    // a stranger could plant an application in any team — spending its quota,
    // claiming a domain and deploying on its workers.
    const { actions } = await import('./applications/new/+page.server.ts');
    const form = new FormData();
    form.set('name', 'planted');
    form.set('teamId', otherTeamId);

    const result: any = await (actions as any).default({
      request: new Request('http://localhost/applications/new', { method: 'POST', body: form }),
      cookies: member.cookies,
    });

    expect(result.status).toBe(403);
    const planted = await db
      .select()
      .from(applications)
      .where(eq(applications.name, 'planted'))
      .get();
    expect(planted).toBeUndefined();
  });

  test('a member cannot park an application in another team\'s stack', async () => {
    // A stack scopes bulk deploy/stop/restart, so an application inside another
    // team's stack is one that team can act on.
    const { actions } = await import('./applications/new/+page.server.ts');
    const form = new FormData();
    form.set('name', 'parked');
    form.set('teamId', teamId);
    form.set('stackId', otherStackId);

    const result: any = await (actions as any).default({
      request: new Request('http://localhost/applications/new', { method: 'POST', body: form }),
      cookies: member.cookies,
    });

    expect(result.status).toBe(400);
    expect(result.data?.error).toContain('stack');
  });

  test('an admin still reaches all of it', async () => {
    // Proves the fixtures are reachable, so the refusals above are the check
    // firing rather than a missing row.
    const stackGet = (await import('./api/stacks/[id]/+server.ts')).GET;
    const depGet = (await import('./api/applications/[id]/deployments/+server.ts')).GET;

    expect((await stackGet({ params: { id: otherStackId }, cookies: admin.cookies } as any)).status).toBe(200);
    expect((await depGet({ params: { id: otherAppId }, cookies: admin.cookies } as any)).status).toBe(200);
  });
});

/**
 * Serving Monaco's assets must not serve anything else.
 *
 * `params.path` arrives percent-decoded, so `%2e%2e%2f` reached the handler as
 * `../` and `join` resolved it — an unauthenticated read of any file the process
 * could open, including the SQLite database and the file holding ENCRYPTION_KEY.
 */
describe('monaco asset route', () => {
  async function get(path: string) {
    const { GET } = await import('./monaco-editor/[...path]/+server.ts');
    return GET({ params: { path } } as any);
  }

  const ESCAPES = [
    '../../package.json',
    '../../data/.secrets.json',
    '../../../../../../etc/passwd',
    './../../package.json',
  ] as const;

  for (const path of ESCAPES) {
    test(`refuses to escape its directory via "${path}"`, async () => {
      expect((await get(path)).status).toBe(404);
    });
  }

  test('refuses a file kind it does not serve, even inside the package', async () => {
    expect((await get('package.json.bak')).status).toBe(404);
  });

  test('still serves a real asset', async () => {
    const response = await get('min/vs/loader.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/javascript');
  });
});

/**
 * The login limiter's per-address bucket must not be the caller's to switch off.
 *
 * It is skipped when the client address cannot distinguish callers, which is a
 * property of the deployment (is there a proxy, and is ADDRESS_HEADER set) — not
 * of the request. Deciding it from `X-Forwarded-For` let anyone on a direct
 * connection opt out of their own limit by sending the header.
 */
describe('login per-address limit', () => {
  async function attemptLogin(ip: string, headers: Record<string, string>) {
    const { actions } = await import('./login/+page.server.ts');
    const body = new FormData();
    body.set('username', 'no-such-user-at-all');
    body.set('password', 'wrong-password');

    return (actions as any).default({
      request: new Request('http://localhost/login', { method: 'POST', headers, body }),
      cookies: cookiesFor(null),
      getClientAddress: () => ip,
    });
  }

  test('a forged X-Forwarded-For does not stop the address bucket being consumed', async () => {
    const ip = '198.51.100.7';
    const key = `login:ip:${ip}`;
    reset(key);

    await attemptLogin(ip, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });

    // A limit of one is refused only if the bucket already holds an attempt, so
    // this fails if the login skipped the per-address consume.
    expect(consume(key, { limit: 1, windowMs: 60_000 }).allowed).toBe(false);
  });

  test('the probe itself proves nothing on an untouched address', async () => {
    // Guards the assertion above: without this, a consume() that always refused
    // would satisfy it.
    const key = `login:ip:${crypto.randomUUID()}`;
    expect(consume(key, { limit: 1, windowMs: 60_000 }).allowed).toBe(true);
  });
});

describe('password policy', () => {
  async function createUser(body: Record<string, unknown>) {
    const { POST } = await import('./api/users/+server.ts');
    return POST({
      cookies: admin.cookies,
      request: new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    } as any);
  }

  const base = { username: 'policy-check', email: 'policy@example.test', fullName: 'Policy Check' };

  test('a short password is refused, not hashed', async () => {
    // "short" was accepted, and the account it created could log in.
    const response = await createUser({ ...base, password: 'short' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/at least 8/);
  });

  test('a missing password is refused', async () => {
    const response = await createUser(base);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/required/i);
  });

  test('an acceptable password is taken', async () => {
    const response = await createUser({ ...base, password: 'long-enough-to-pass' });
    expect(response.status).toBe(201);
  });
});

/**
 * Second write paths.
 *
 * Both of these pages had a form action that duplicated an endpoint's job and
 * not its authorization: the action checked that a session existed and then
 * trusted the posted ids. `/settings/volumes` no longer has actions at all —
 * the page writes through `/api/volumes`, which is covered above — and
 * `/templates` keeps its actions, so its own membership check is asserted here.
 */
describe('page form actions', () => {
  test('/settings/volumes exposes no form actions of its own', async () => {
    // A `create` action here trusted the posted teamId, so a member could plant
    // a volume in another team — mountable into that team's containers. If
    // actions come back, they need the tenancy rules `/api/volumes` has.
    const mod: any = await import('./settings/volumes/+page.server.ts');
    expect(mod.actions).toBeUndefined();
  });

  test('/templates save refuses another team\'s application', async () => {
    // Mirrors the `/api/templates/save` case above. The application was fetched
    // by id alone, so this copied any application in the installation —
    // environment block included — into a template owned by its team.
    const { actions } = await import('./templates/+page.server.ts');
    const form = new FormData();
    form.set('appId', otherAppId);
    form.set('name', 'page-action-stolen-template');

    const result: any = await (actions as any).save({
      request: new Request('http://localhost/templates', { method: 'POST', body: form }),
      cookies: member.cookies,
    });

    expect(result.status).toBe(404);
    const planted = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.name, 'page-action-stolen-template'))
      .get();
    expect(planted).toBeUndefined();
  });

  test('/templates save still snapshots an application the caller can reach', async () => {
    // Guards the refusal above: without this it would pass just as well if the
    // action were broken for everyone.
    const { actions } = await import('./templates/+page.server.ts');
    const ownAppId = crypto.randomUUID();
    const now = new Date();
    await db.insert(applications).values({
      id: ownAppId,
      name: 'own-team-app-for-template',
      teamId,
      type: 'single',
      deploymentFormat: 'compose',
      manifest: 'image: nginx:1.27',
      restartPolicy: 'always',
      createdAt: now,
      updatedAt: now,
    });

    const form = new FormData();
    form.set('appId', ownAppId);
    form.set('name', 'own-team-template');

    const result: any = await (actions as any).save({
      request: new Request('http://localhost/templates', { method: 'POST', body: form }),
      cookies: member.cookies,
    });

    expect(result.success).toBe(true);
  });
});

/**
 * Deleting a team.
 *
 * Eleven tables reference `teams.id` and none of them cascades, with
 * `PRAGMA foreign_keys = ON`. The two-statement version dropped the memberships
 * and then failed on the foreign key, so a team that owned anything could not be
 * deleted — and was left with nobody in it.
 */
describe('team deletion', () => {
  async function del(id: string, actor: Actor) {
    const { DELETE } = await import('./api/teams/[id]/+server.ts');
    return DELETE({ params: { id }, cookies: actor.cookies } as any);
  }

  /** A team `owner` owns outright. */
  async function ownedTeam(slug: string, owner: Actor | null): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(teams).values({ id, name: slug, slug, createdAt: now, updatedAt: now });
    if (owner) {
      await db.insert(teamMembers).values({ teamId: id, userId: owner.id, role: 'owner', joinedAt: now });
    }
    return id;
  }

  test('refuses a team that still owns an application, and leaves it whole', async () => {
    const id = await ownedTeam('doomed-with-app', member);
    const now = new Date();
    await db.insert(applications).values({
      id: crypto.randomUUID(),
      name: 'app-blocking-team-delete',
      teamId: id,
      type: 'single',
      deploymentFormat: 'compose',
      restartPolicy: 'always',
      createdAt: now,
      updatedAt: now,
    });

    const response = await del(id, member);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('app-blocking-team-delete');

    // Both halves of the old failure: the team survives *and* so do its members.
    expect(await db.select().from(teams).where(eq(teams.id, id)).get()).toBeTruthy();
    expect((await db.select().from(teamMembers).where(eq(teamMembers.teamId, id)).all()).length).toBe(1);
  });

  test('refuses a team that still owns a stack', async () => {
    const id = await ownedTeam('doomed-with-stack', member);
    const now = new Date();
    await db.insert(stacks).values({
      id: crypto.randomUUID(),
      name: 'stack-blocking-team-delete',
      teamId: id,
      createdAt: now,
      updatedAt: now,
    });

    expect((await del(id, member)).status).toBe(409);
  });

  test('removes a team together with everything that only existed because of it', async () => {
    const id = await ownedTeam('doomed-clean', member);
    const now = new Date();

    const keyId = crypto.randomUUID();
    const volumeId = crypto.randomUUID();
    const secretId = crypto.randomUUID();
    const quotaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const ruleId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    /** A rule in *another* team pointing at the doomed team's channel. */
    const foreignRuleId = crypto.randomUUID();

    await db.insert(apiKeys).values({ id: keyId, name: 'doomed-key', keyHash: 'hash', teamId: id, createdAt: now });
    await db.insert(volumes).values({
      id: volumeId, name: 'doomed-volume', teamId: id, containerPath: '/data', createdAt: now, updatedAt: now,
    });
    await db.insert(secrets).values({
      id: secretId, name: 'DOOMED', value: 'enc', scope: 'team', deliveryMode: 'env',
      teamId: id, createdBy: member.id, createdAt: now, updatedAt: now,
    });
    await db.insert(teamQuotas).values({ id: quotaId, teamId: id, createdAt: now, updatedAt: now });
    await db.insert(notificationChannels).values({
      id: channelId, name: 'doomed-channel', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.test' }), teamId: id, createdAt: now, updatedAt: now,
    });
    await db.insert(alertRules).values([
      {
        id: ruleId, name: 'doomed-rule', resourceType: 'container', metric: 'cpu_percent',
        operator: 'gt', threshold: 90, channelId, teamId: id, createdAt: now, updatedAt: now,
      },
      {
        id: foreignRuleId, name: 'foreign-rule', resourceType: 'container', metric: 'cpu_percent',
        operator: 'gt', threshold: 90, channelId, teamId: otherTeamId, createdAt: now, updatedAt: now,
      },
    ]);
    await db.insert(alertEvents).values({
      id: eventId, ruleId, resourceType: 'container', metric: 'cpu_percent',
      value: 95, threshold: 90, message: 'over', createdAt: now,
    });
    await db.insert(applicationTemplates).values({
      id: templateId, name: 'doomed-template', teamId: id, type: 'single',
      deploymentFormat: 'compose', restartPolicy: 'always', createdAt: now, updatedAt: now,
    });
    await db.insert(auditLogs).values({
      id: auditId, userId: member.id, teamId: id, action: 'CREATE',
      resourceType: 'team', resourceId: id, details: '{}', createdAt: now,
    });

    const response = await del(id, member);
    expect(response.status).toBe(200);

    expect(await db.select().from(teams).where(eq(teams.id, id)).get()).toBeUndefined();
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get()).toBeUndefined();
    expect(await db.select().from(volumes).where(eq(volumes.id, volumeId)).get()).toBeUndefined();
    expect(await db.select().from(secrets).where(eq(secrets.id, secretId)).get()).toBeUndefined();
    expect(await db.select().from(teamQuotas).where(eq(teamQuotas.id, quotaId)).get()).toBeUndefined();
    expect(await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)).get()).toBeUndefined();
    expect(await db.select().from(alertRules).where(eq(alertRules.id, ruleId)).get()).toBeUndefined();
    expect(await db.select().from(alertEvents).where(eq(alertEvents.id, eventId)).get()).toBeUndefined();
    expect(await db.select().from(applicationTemplates).where(eq(applicationTemplates.id, templateId)).get()).toBeUndefined();
    expect((await db.select().from(teamMembers).where(eq(teamMembers.teamId, id)).all()).length).toBe(0);

    // The audit row is the record of what was done to the team, so it outlives
    // it — unlinked, not deleted.
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.id, auditId)).get();
    expect(audit).toBeTruthy();
    expect(audit?.teamId).toBeNull();

    // Another team's rule kept its threshold and lost only the channel it can no
    // longer reach. Deleting the channel without this fails on the foreign key.
    const foreign = await db.select().from(alertRules).where(eq(alertRules.id, foreignRuleId)).get();
    expect(foreign).toBeTruthy();
    expect(foreign?.channelId).toBeNull();
  });

  test('a plain member cannot delete their own team', async () => {
    const id = await ownedTeam('not-yours-to-delete', null);
    const now = new Date();
    await db.insert(teamMembers).values({ teamId: id, userId: member.id, role: 'member', joinedAt: now });

    expect((await del(id, member)).status).toBe(403);
    expect(await db.select().from(teams).where(eq(teams.id, id)).get()).toBeTruthy();
  });

  test('an admin can delete an ownerless team', async () => {
    // Every team created by OIDC group sync has no owner row, so an
    // owner-only check made them permanently unmanageable.
    const id = await ownedTeam('ownerless-team', null);
    expect((await del(id, admin)).status).toBe(200);
    expect(await db.select().from(teams).where(eq(teams.id, id)).get()).toBeUndefined();
  });

  test('a stranger is told nothing about a team they are not in', async () => {
    const id = await ownedTeam('stranger-cannot-see', member);
    expect((await del(id, loner)).status).toBe(403);
  });
});
