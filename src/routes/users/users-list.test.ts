/**
 * What the users list tells an admin about an account.
 *
 * Two questions it could not answer before, both of which matter the moment OIDC
 * is switched on: how does this account sign in, and which teams is it in. With
 * team membership synced from a claim, "why can this person see that
 * application" is answered by a column here or by reading the database.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { teamMembers, teams, userOidc, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { load } from './+page.server';

const ids = {
  admin: crypto.randomUUID(),
  local: crypto.randomUUID(),
  oidc: crypto.randomUUID(),
  both: crypto.randomUUID(),
  team: crypto.randomUUID(),
  secondTeam: crypto.randomUUID(),
};

const SYNCED_AT = new Date(1_700_000_000_000);
const SEEN_AT = new Date(1_700_086_400_000);

async function makeUser(
  id: string,
  name: string,
  passwordHash: string | null,
  role: 'admin' | 'member' = 'member',
) {
  const now = new Date();
  await db.insert(users).values({
    id,
    username: name,
    email: `${name}@example.test`,
    passwordHash,
    fullName: name,
    role,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  const now = new Date();
  await makeUser(ids.admin, 'list-admin', 'hash', 'admin');
  await makeUser(ids.local, 'list-local', 'hash');
  await makeUser(ids.oidc, 'list-oidc', null);
  await makeUser(ids.both, 'list-both', 'hash');

  for (const userId of [ids.oidc, ids.both]) {
    await db.insert(userOidc).values({
      id: crypto.randomUUID(),
      userId,
      provider: 'auth0',
      providerId: `generic:${userId}`,
      lastSyncedAt: SYNCED_AT,
    });
  }

  await db.insert(teams).values([
    { id: ids.team, name: 'List Payments', slug: 'list-payments', createdAt: now, updatedAt: now },
    { id: ids.secondTeam, name: 'List Platform', slug: 'list-platform', createdAt: now, updatedAt: now },
  ]);
  await db.insert(teamMembers).values([
    { teamId: ids.team, userId: ids.oidc, joinedAt: now },
    { teamId: ids.secondTeam, userId: ids.oidc, joinedAt: now },
  ]);
});

async function loaded() {
  return (await load({
    locals: {
      auth: {
        user: {
          id: ids.admin,
          username: 'list-admin',
          email: 'list-admin@example.test',
          role: 'admin',
          fullName: 'list-admin',
        },
        sessionUserId: ids.admin,
      },
    },
  } as any)) as any;
}

async function listed() {
  const result = await loaded();
  return new Map<string, any>(result.usersList.map((u: any) => [u.id, u]));
}

describe('users list', () => {
  test('marks a password account local and an IdP account OIDC', async () => {
    const rows = await listed();

    expect(rows.get(ids.local)).toMatchObject({ isLocal: true, isOidc: false });
    expect(rows.get(ids.oidc)).toMatchObject({ isLocal: false, isOidc: true });
  });

  test('an account that is both is marked both, not one or the other', async () => {
    // A local account later linked to the provider keeps its password, so it can
    // still be signed into either way — and showing only one would misstate how.
    expect((await listed()).get(ids.both)).toMatchObject({ isLocal: true, isOidc: true });
  });

  test('reports when an OIDC account last came through the provider', async () => {
    expect((await listed()).get(ids.oidc).lastSyncedAt).toEqual(SYNCED_AT);
  });

  test('lists the teams an account belongs to', async () => {
    const teamsOf = (await listed()).get(ids.oidc).teams;

    expect(teamsOf.map((t: any) => t.teamName)).toEqual(['List Payments', 'List Platform']);
  });

  test('an account in no team has an empty list, not a missing one', async () => {
    expect((await listed()).get(ids.local).teams).toEqual([]);
  });

  test('carries every team, so the add-to-team picker can offer the ones they are not in', async () => {
    // Membership is managed from this page now; the rows above only say which
    // teams an account is already in, which is the wrong half for a picker.
    const names = (await loaded()).teams.map((t: any) => t.name);

    expect(names).toContain('List Payments');
    expect(names).toContain('List Platform');
    expect([...names]).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
  });

  test('reports when an account was last used, and null when it never was', async () => {
    // The question an operator asks before deleting a dormant account, and the
    // one the list could not answer: `createdAt` says when it was made, not
    // whether anyone has signed into it since.
    await db.update(users).set({ lastSeenAt: SEEN_AT }).where(eq(users.id, ids.local));

    const rows = await listed();
    expect(rows.get(ids.local).lastSeenAt).toEqual(SEEN_AT);
    expect(rows.get(ids.both).lastSeenAt).toBeNull();
  });

  test('never returns the password hash it derives `isLocal` from', async () => {
    const row = (await listed()).get(ids.local);
    expect(row).not.toHaveProperty('passwordHash');
  });
});
