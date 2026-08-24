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
  sessions,
  teamMembers,
  teamQuotas,
  teams,
  users,
  volumes,
  workers,
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
  /**
   * What `hooks.server.ts` would have put on the request.
   *
   * Identity is resolved once per request in the hook and read from `locals`
   * by the handlers, so a test that only supplies `cookies` is testing a
   * request that never went through the hook — every handler would see an
   * anonymous caller and the 403 assertions would pass for the wrong reason.
   * Built here exactly as the hook builds it.
   */
  locals: App.Locals;
}

function localsFor(user: { id: string; username: string; role: 'admin' | 'member' }): App.Locals {
  return {
    userId: user.id,
    userRole: user.role,
    auth: {
      user: {
        id: user.id,
        username: user.username,
        email: `${user.username}@example.test`,
        role: user.role,
        fullName: user.username,
      },
      sessionUserId: user.id,
    },
  };
}

/** No session, and no API key — what an unauthenticated request looks like. */
const ANONYMOUS_LOCALS: App.Locals = { auth: null };

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
  return {
    id,
    cookies: cookiesFor(await createSession(id)),
    locals: localsFor({ id, username, role }),
  };
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
  await db.insert(teamMembers).values({ teamId, userId: member.id, joinedAt: now });

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
    'settings',
    'settings/notifications',
    'settings/oidc',
    'settings/backup',
    'audit',
    'users',
  ] as const;

  for (const page of PAGES) {
    test(`/${page} redirects a member`, async () => {
      const { load } = await import(`./${page}/+page.server.ts`);
      const event = { cookies: member.cookies, locals: member.locals, url: new URL('http://localhost/') };
      expect(await loadRedirect(load, event)).toBe('/dashboard');
    });

    test(`/${page} redirects an anonymous caller to the login page`, async () => {
      const { load } = await import(`./${page}/+page.server.ts`);
      const event = { cookies: anonymous, locals: ANONYMOUS_LOCALS, url: new URL('http://localhost/') };
      expect(await loadRedirect(load, event)).toBe('/login');
    });

    test(`/${page} lets an admin through`, async () => {
      const { load } = await import(`./${page}/+page.server.ts`);
      const event = { cookies: admin.cookies, locals: admin.locals, url: new URL('http://localhost/') };
      expect(await loadRedirect(load, event)).toBeNull();
    });
  }
});

describe('dashboard scoping', () => {
  async function dashboard(actor: Actor) {
    const { load } = await import('./dashboard/+page.server.ts');
    return (await load({
      locals: actor.locals,
      url: new URL('http://localhost/dashboard'),
    })) as any;
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

  test('worker resources carry no credential columns', async () => {
    // The capacity panel needs an id, a name and three numbers. It used to be
    // handed the whole row: an admin loading the dashboard received every
    // worker's config token, OIDC client secret and session key, Podman client
    // key, CrowdSec bouncer key and control-plane password. Encrypted at rest,
    // so ciphertext rather than plaintext, and no reason at all to be there.
    // Created here rather than in the shared fixture: the tests above assert on
    // an empty worker list, and this one needs a row whose secret columns are
    // actually populated for the assertion to mean anything.
    await db.insert(workers).values({
      id: crypto.randomUUID(),
      name: 'boundary-worker',
      hostname: 'boundary.example.com',
      sshPort: 22,
      sshUser: 'root',
      status: 'online',
      baseDomain: 'apps.example.com',
      podmanApiUrl: 'https://podman-api.apps.example.com',
      createdAt: new Date(),
      podmanClientKey: 'client-key',
      crowdsecBouncerKey: 'bouncer-key',
      oidcClientSecret: 'oidc-secret',
      oidcEncryptionKey: 'a'.repeat(32),
      configToken: 'config-token',
      configBasicPassword: 'proxy-password',
    });

    const resources = (await dashboard(admin)).workerResources;
    expect(resources.length).toBeGreaterThan(0);

    for (const entry of resources) {
      for (const secret of [
        'podmanClientKey',
        'crowdsecBouncerKey',
        'oidcClientSecret',
        'oidcEncryptionKey',
        'configToken',
        'configBasicPassword',
      ]) {
        expect(entry.worker).not.toHaveProperty(secret);
      }
      // Still usable for what the panel actually renders.
      expect(entry.worker.id).toBeTruthy();
      expect(entry.worker).toHaveProperty('name');
    }
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
        locals: member.locals,
        url: new URL('http://localhost/'),
        request: new Request('http://localhost/'),
      } as any);
      expect(response.status).toBe(403);
    });

    test(`${path} ${method} refuses an anonymous caller`, async () => {
      const handlers = await import(path);
      const response = await handlers[method]({
        cookies: anonymous,
        locals: ANONYMOUS_LOCALS,
        url: new URL('http://localhost/'),
        request: new Request('http://localhost/'),
      } as any);
      expect(response.status).toBe(401);
    });

    test(`${path} ${method} answers an admin`, async () => {
      const handlers = await import(path);
      const response = await handlers[method]({
        cookies: admin.cookies,
        locals: admin.locals,
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
      locals: member.locals,
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
      locals: member.locals,
      request: new Request('http://localhost/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sneaky', resourceType: 'worker', metric: 'cpu_percent', threshold: 1 }),
      }),
    } as any);

    expect(response.status).toBe(403);
  });

  // ── The regression the `locals` migration could have introduced ────────────
  //
  // Every handler above now reads identity from `locals` instead of resolving
  // it from the cookie itself. A handler that was converted but whose caller
  // was not — or one that silently fell back to "no session" — would answer 401
  // to a legitimate admin, or, far worse, read `locals.auth` from a request the
  // hook never touched. These pin both directions.

  test('a converted handler ignores a cookie the hook did not resolve', async () => {
    // Admin cookie, but no `locals`: this is a request that never went through
    // hooks.server.ts. It must be refused, not trusted.
    const { GET } = await import('./api/alerts/+server.ts');
    const response = await GET({
      cookies: admin.cookies,
      locals: {},
      url: new URL('http://localhost/'),
      request: new Request('http://localhost/'),
    } as any);
    expect(response.status).toBe(401);
  });

  test('locals cannot be forged into an admin by a member request', async () => {
    // `locals.auth` is only ever written by the hook from a validated session.
    // A member's own locals must not satisfy an admin check no matter how the
    // rest of the event is shaped.
    const { GET } = await import('./api/alerts/events/+server.ts');
    const response = await GET({
      cookies: admin.cookies,
      locals: member.locals,
      url: new URL('http://localhost/'),
      request: new Request('http://localhost/'),
    } as any);
    expect(response.status).toBe(403);
  });
});

/**
 * Reaching another team's resources.
 *
 * These routes authenticated the caller and then looked the resource up by
 * id alone, so a member of any team could read and act on every other team's
 * applications, deploy history and volumes. Each test names the route and
 * the thing it used to hand over.
 */
describe('cross-team resource access', () => {
  const jsonRequest = (url: string, method: string, body?: unknown) =>
    new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('a member cannot read another team\'s deploy history', async () => {
    const { GET } = await import('./api/applications/[id]/deployments/+server.ts');
    const response = await GET({
      params: { id: otherAppId },
      cookies: member.cookies, locals: member.locals,
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot roll back another team\'s application', async () => {
    // The rollback overwrote the application's manifest, environment and volumes
    // before the deploy call it delegated to could refuse.
    const { POST } = await import('./api/applications/[id]/deployments/+server.ts');
    const response = await POST({
      params: { id: otherAppId },
      cookies: member.cookies, locals: member.locals,
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
      cookies: member.cookies, locals: member.locals,
      request: new Request('http://localhost/api/templates/save', { method: 'POST', body: form }),
    } as any);

    expect(response.status).toBe(404);
  });

  test('a member cannot open another team\'s application for editing', async () => {
    const { load } = await import('./applications/[id]/edit/+page.server.ts');
    expect(
      await loadRedirect(load, { params: { id: otherAppId }, cookies: member.cookies, locals: member.locals }),
    ).toBe('/applications');
  });

  test('a member cannot read or delete another team\'s volume', async () => {
    // 404, not 403: a 403 would confirm the id names a real volume in some team
    // the caller is not in.
    const { GET, DELETE } = await import('./api/volumes/[id]/+server.ts');
    const event = { params: { id: otherVolumeId }, cookies: member.cookies, locals: member.locals } as any;

    expect((await GET(event)).status).toBe(404);
    expect((await DELETE(event)).status).toBe(404);
  });

  test('a member of the owning team may delete its volume', async () => {
    // This used to need the team `owner` role, and answered a plain member with
    // 403. Teams are flat now: a member who can mount the volume into one of the
    // team's containers is not meaningfully restrained by being unable to delete
    // it.
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
    // A `url` because DELETE reads `?data=1` to decide whether to remove the
    // Podman volume as well as the row. Absent, the default applies: the row
    // goes and nothing on any worker is touched — which is what this asserts.
    const event = {
      params: { id: ownVolumeId },
      url: new URL(`http://localhost/api/volumes/${ownVolumeId}`),
      cookies: member.cookies,
      locals: member.locals,
    } as any;

    expect((await GET(event)).status).toBe(200);
    expect((await DELETE(event)).status).toBe(200);
  });

  test('a teamless volume is admin-only, not everyone\'s', async () => {
    // `role !== 'admin' && volume.teamId` skipped the membership check entirely
    // when there was no team to check against.
    const { GET, DELETE } = await import('./api/volumes/[id]/+server.ts');
    const event = { params: { id: orphanVolumeId }, cookies: member.cookies, locals: member.locals } as any;

    expect((await GET(event)).status).toBe(404);
    expect((await DELETE(event)).status).toBe(404);
    // Still there, and an admin can still reach it.
    expect((await GET({ params: { id: orphanVolumeId }, cookies: admin.cookies, locals: admin.locals } as any)).status).toBe(200);
  });

  /**
   * The application storage surface.
   *
   * Every route under `/api/applications/:id/volumes` takes a volume *name* out
   * of the URL, and that name reaches Podman. A route that resolved it without
   * first establishing that this application uses it would be a free hand on
   * every volume on the worker — another team's database included, on a shared
   * one. Both halves are asserted: the application must be reachable, and so
   * must the volume.
   */
  describe('application volumes', () => {
    const volumeEvent = (appId: string, name: string, actor: Actor, search = '') =>
      ({
        params: { id: appId, name },
        url: new URL(
          `http://localhost/api/applications/${appId}/volumes/${encodeURIComponent(name)}${search}`,
        ),
        cookies: actor.cookies,
        locals: actor.locals,
        request: new Request('http://localhost/x', { method: 'POST' }),
      }) as any;

    test('a member cannot list another team\'s application storage', async () => {
      const { GET } = await import('./api/applications/[id]/volumes/+server.ts');
      const response = await GET({
        params: { id: otherAppId },
        url: new URL(`http://localhost/api/applications/${otherAppId}/volumes`),
        cookies: member.cookies,
        locals: member.locals,
      } as any);

      expect(response.status).toBe(404);
    });

    test('a member cannot delete, back up, restore or copy another team\'s volume', async () => {
      // 404 on the application, before the volume name is looked at — so the
      // route is not an oracle for which volumes another team has either.
      const name = 'rudder-deadbeef-db-data';
      const [remove, backup, restore, copy] = await Promise.all([
        import('./api/applications/[id]/volumes/[name]/+server.ts'),
        import('./api/applications/[id]/volumes/[name]/backup/+server.ts'),
        import('./api/applications/[id]/volumes/[name]/restore/+server.ts'),
        import('./api/applications/[id]/volumes/[name]/copy/+server.ts'),
      ]);

      expect((await remove.DELETE(volumeEvent(otherAppId, name, member))).status).toBe(404);
      expect((await remove.GET(volumeEvent(otherAppId, name, member))).status).toBe(404);
      expect((await backup.GET(volumeEvent(otherAppId, name, member))).status).toBe(404);
      expect((await restore.POST(volumeEvent(otherAppId, name, member))).status).toBe(404);
      expect((await copy.POST(volumeEvent(otherAppId, name, member))).status).toBe(404);
      expect((await copy.PUT(volumeEvent(otherAppId, name, member))).status).toBe(404);
    });

    test('an application with no worker cannot have its volumes acted on', async () => {
      // `otherAppId` has no `workerId`, so there is nowhere for a volume to be.
      // Refused with its own message rather than a Podman error three calls in.
      const { DELETE } = await import('./api/applications/[id]/volumes/[name]/+server.ts');
      const response = await DELETE(volumeEvent(otherAppId, 'anything', admin));

      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('not assigned to a worker');
    });
  });

  test('a volume cannot be created without an owning team', async () => {
    const { POST } = await import('./api/volumes/+server.ts');
    const response = await POST({
      cookies: member.cookies, locals: member.locals,
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
      cookies: member.cookies, locals: member.locals,
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
      cookies: member.cookies, locals: member.locals,
    });

    expect(result.status).toBe(403);
    const planted = await db
      .select()
      .from(applications)
      .where(eq(applications.name, 'planted'))
      .get();
    expect(planted).toBeUndefined();
  });

  test('an admin still reaches all of it', async () => {
    // Proves the fixtures are reachable, so the refusals above are the check
    // firing rather than a missing row.
    const depGet = (await import('./api/applications/[id]/deployments/+server.ts')).GET;

    expect((await depGet({ params: { id: otherAppId }, cookies: admin.cookies, locals: admin.locals } as any)).status).toBe(200);
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
      cookies: admin.cookies, locals: admin.locals,
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
 * trusted the posted ids. `/volumes` no longer has actions at all —
 * the page writes through `/api/volumes`, which is covered above — and
 * `/templates` keeps its actions, so its own membership check is asserted here.
 */
describe('page form actions', () => {
  test('/volumes exposes no form actions of its own', async () => {
    // A `create` action here trusted the posted teamId, so a member could plant
    // a volume in another team — mountable into that team's containers. If
    // actions come back, they need the tenancy rules `/api/volumes` has.
    const mod: any = await import('./volumes/+page.server.ts');
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
      cookies: member.cookies, locals: member.locals,
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
      cookies: member.cookies, locals: member.locals,
    });

    expect(result.success).toBe(true);
  });
});

/**
 * Managing team membership, which now lives on `/users` rather than on the team
 * detail page.
 *
 * Admin-only in both directions. Adding was an owner's job and self-removal
 * needed nothing at all; with the `owner` role gone there is no tier between
 * member and admin to hang either on, and `/users` — where this now lives — is
 * admin-only anyway.
 */
describe('team membership', () => {
  let membershipTeamId: string;

  async function post(teamId: string, actor: Actor, body: unknown) {
    const { POST } = await import('./api/teams/[id]/members/+server.ts');
    return POST({
      params: { id: teamId },
      cookies: actor.cookies,
      locals: actor.locals,
      request: new Request(`http://localhost/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    } as any);
  }

  async function del(teamId: string, actor: Actor, memberId: string) {
    const { DELETE } = await import('./api/teams/[id]/members/+server.ts');
    return DELETE({
      params: { id: teamId },
      cookies: actor.cookies,
      locals: actor.locals,
      url: new URL(`http://localhost/api/teams/${teamId}/members?memberId=${memberId}`),
    } as any);
  }

  beforeAll(async () => {
    membershipTeamId = crypto.randomUUID();
    const now = new Date();
    await db.insert(teams).values({
      id: membershipTeamId,
      name: 'membership-moves',
      slug: 'membership-moves',
      createdAt: now,
      updatedAt: now,
    });
  });

  test('an admin adds a user to a team by id', async () => {
    // `/users` posts a userId; the team page used to post an email.
    const response = await post(membershipTeamId, admin, { userId: loner.id });
    expect(response.status).toBe(200);
  });

  test('a member cannot add themselves to a team', async () => {
    const response = await post(membershipTeamId, member, { userId: member.id });
    expect(response.status).toBe(403);
  });

  test('a member of the team cannot add anyone either', async () => {
    // The old rule was "owners can". There is no owner, so the answer is nobody
    // but an admin — otherwise every member could recruit into their own tenant.
    await post(membershipTeamId, admin, { userId: member.id });

    expect((await post(membershipTeamId, member, { userId: admin.id })).status).toBe(403);
  });

  test('an admin removes a member', async () => {
    expect((await del(membershipTeamId, admin, loner.id)).status).toBe(200);
    expect(
      await db.select().from(teamMembers).where(eq(teamMembers.userId, loner.id)).get(),
    ).toBeUndefined();
  });

  test('a member cannot remove anyone, including themselves', async () => {
    // Self-removal used to be allowed without ownership. It went with the rest:
    // membership is written from `/users` or from the OIDC claim, and a member
    // quietly leaving is neither.
    expect((await del(membershipTeamId, member, member.id)).status).toBe(403);
    expect(
      await db.select().from(teamMembers).where(eq(teamMembers.userId, member.id)).get(),
    ).toBeTruthy();
  });
});

/**
 * Promoting an account, and resetting its password.
 *
 * Both run through `PATCH /api/users/[id]`, whose field-by-field permissions are
 * the whole point: `role` and `username` are admin-only, `password` revokes every
 * session it invalidates, and a member may edit nothing but their own profile.
 */
describe('user administration', () => {
  async function patch(targetId: string, actor: Actor, body: unknown) {
    const { PATCH } = await import('./api/users/[id]/+server.ts');
    return PATCH({
      params: { id: targetId },
      cookies: actor.cookies,
      locals: actor.locals,
      request: new Request(`http://localhost/api/users/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    } as any);
  }

  test('an admin promotes a member and demotes them again', async () => {
    const target = await makeUser('promotion-target', 'member');

    expect((await patch(target.id, admin, { role: 'admin' })).status).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, target.id)).get())?.role).toBe('admin');

    expect((await patch(target.id, admin, { role: 'member' })).status).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, target.id)).get())?.role).toBe('member');
  });

  test('a member cannot promote themselves', async () => {
    // `role` is in the admin-only field list, so this succeeds as a profile
    // update and silently changes nothing — the account must still be a member.
    await patch(member.id, member, { role: 'admin' });

    expect((await db.select().from(users).where(eq(users.id, member.id)).get())?.role).toBe('member');
  });

  test('an admin sets another account’s password, and its sessions are revoked', async () => {
    const target = await makeUser('reset-target', 'member');
    await createSession(target.id);

    expect((await patch(target.id, admin, { password: 'a-whole-new-passphrase' })).status).toBe(200);

    const after = await db.select().from(users).where(eq(users.id, target.id)).get();
    expect(after?.passwordHash).toBeTruthy();
    expect(after?.passwordHash).not.toBe('a-whole-new-passphrase');
    // The point of revoking: a reset is what you do when the old one leaked.
    expect((await db.select().from(sessions).where(eq(sessions.userId, target.id)).all()).length).toBe(0);
  });

  test('a short password is refused rather than hashed', async () => {
    const target = await makeUser('short-password-target', 'member');
    const before = (await db.select().from(users).where(eq(users.id, target.id)).get())?.passwordHash;

    expect((await patch(target.id, admin, { password: 'short' })).status).toBe(400);
    expect((await db.select().from(users).where(eq(users.id, target.id)).get())?.passwordHash).toBe(before!);
  });

  test('a member cannot set someone else’s password', async () => {
    const target = await makeUser('not-your-password', 'member');
    const before = (await db.select().from(users).where(eq(users.id, target.id)).get())?.passwordHash;

    expect((await patch(target.id, member, { password: 'a-whole-new-passphrase' })).status).toBe(403);
    expect((await db.select().from(users).where(eq(users.id, target.id)).get())?.passwordHash).toBe(before!);
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
    return DELETE({ params: { id }, cookies: actor.cookies, locals: actor.locals } as any);
  }

  /** A team, optionally with one member in it. */
  async function ownedTeam(slug: string, occupant: Actor | null): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(teams).values({ id, name: slug, slug, createdAt: now, updatedAt: now });
    if (occupant) {
      await db.insert(teamMembers).values({ teamId: id, userId: occupant.id, joinedAt: now });
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

    const response = await del(id, admin);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('app-blocking-team-delete');

    // Both halves of the old failure: the team survives *and* so do its members.
    expect(await db.select().from(teams).where(eq(teams.id, id)).get()).toBeTruthy();
    expect((await db.select().from(teamMembers).where(eq(teamMembers.teamId, id)).all()).length).toBe(1);
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

    const response = await del(id, admin);
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

  test('a member of the team cannot delete it', async () => {
    // Deleting used to be an owner's prerogative and is now an admin's. Being in
    // the team is what lets you use it, not what lets you destroy it.
    const id = await ownedTeam('not-yours-to-delete', member);

    expect((await del(id, member)).status).toBe(403);
    expect(await db.select().from(teams).where(eq(teams.id, id)).get()).toBeTruthy();
  });

  test('an admin can delete a team nobody is in', async () => {
    // Every team created by OIDC group sync starts out like this, and an
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
