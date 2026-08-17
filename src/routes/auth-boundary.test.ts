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
import { teamMembers, teams, users } from '$lib/db/schema';
import { createSession, hashPassword } from '$lib/auth';

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
    // Installation-wide entries carry no team, so they must not appear.
    for (const entry of data.recentActivity) {
      expect(entry.teamId ?? null).not.toBeNull();
    }
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
