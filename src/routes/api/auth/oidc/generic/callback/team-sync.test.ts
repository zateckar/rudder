/**
 * Team membership derived from an OIDC claim, in both directions.
 *
 * The sync used only to add, so removing someone from a group in the identity
 * provider left their Rudder access untouched. Withdrawal is the part with edges
 * — an empty claim, an `owner` row, a team the claim does not mention — so it is
 * the part pinned down here.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { teamMembers, teams, users } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { syncUserTeams } from './+server';

/** Team ids by name, so assertions can talk about names. */
const teamIds = new Map<string, string>();

async function makeTeam(name: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(teams).values({
    id,
    name,
    slug: `${name.toLowerCase()}-${id.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
  });
  teamIds.set(name, id);
  return id;
}

async function makeUser(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id,
    username: `oidc-${id.slice(0, 8)}`,
    email: `oidc-${id.slice(0, 8)}@example.test`,
    passwordHash: null,
    fullName: 'OIDC User',
    role: 'member',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function join(userId: string, teamName: string, role: 'owner' | 'member') {
  await db.insert(teamMembers).values({
    teamId: teamIds.get(teamName)!,
    userId,
    role,
    joinedAt: new Date(),
  });
}

/** The teams a user belongs to, by name, sorted so order is not asserted. */
async function membershipsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all();
  const byId = new Map([...teamIds].map(([name, id]) => [id, name]));
  return rows.map((r) => byId.get(r.teamId) ?? r.teamId).sort();
}

beforeAll(async () => {
  await makeTeam('Platform');
  await makeTeam('Payments');
  await makeTeam('Handmade');
});

describe('syncUserTeams', () => {
  test('joins the teams the claim names', async () => {
    const userId = await makeUser();
    await syncUserTeams(userId, ['Platform', 'Payments']);

    expect(await membershipsOf(userId)).toEqual(['Payments', 'Platform']);
  });

  test('matches an existing team case-insensitively rather than creating a second', async () => {
    const userId = await makeUser();
    await syncUserTeams(userId, ['platform']);

    expect(await membershipsOf(userId)).toEqual(['Platform']);
  });

  test('withdraws a membership the claim no longer names', async () => {
    // The revocation this exists for: dropped from the Payments group in the IdP.
    const userId = await makeUser();
    await syncUserTeams(userId, ['Platform', 'Payments']);
    await syncUserTeams(userId, ['Platform']);

    expect(await membershipsOf(userId)).toEqual(['Platform']);
  });

  test('an empty claim withdraws everything', async () => {
    // Removed from every group. Gating the sync on `teamNames.length > 0` made
    // this the one case that changed nothing at all.
    const userId = await makeUser();
    await syncUserTeams(userId, ['Platform', 'Payments']);
    await syncUserTeams(userId, []);

    expect(await membershipsOf(userId)).toEqual([]);
  });

  test('an owner row survives a claim that does not name its team', async () => {
    // The escape hatch: the IdP must not be able to unseat a team's owner, and
    // `owner` is therefore the only way to grant access the claim will not undo.
    const userId = await makeUser();
    await join(userId, 'Handmade', 'owner');
    await syncUserTeams(userId, ['Platform']);

    expect(await membershipsOf(userId)).toEqual(['Handmade', 'Platform']);
  });

  test('a hand-granted member row does not survive — the claim is authoritative', async () => {
    // Nothing records where a membership came from, so this is a consequence
    // rather than a choice. Asserted so it is a known cost of configuring a team
    // claim and not a surprise during an incident.
    const userId = await makeUser();
    await join(userId, 'Handmade', 'member');
    await syncUserTeams(userId, ['Platform']);

    expect(await membershipsOf(userId)).toEqual(['Platform']);
  });

  test('creates a team the claim names but Rudder does not have', async () => {
    const userId = await makeUser();
    const name = `Claimed-${crypto.randomUUID().slice(0, 8)}`;
    await syncUserTeams(userId, [name]);

    const created = await db.select().from(teams).where(eq(teams.name, name)).get();
    expect(created).toBeTruthy();
    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, created!.id)))
      .get();
    expect(membership?.role).toBe('member');
  });

  test('re-running with the same claim is a no-op', async () => {
    const userId = await makeUser();
    await syncUserTeams(userId, ['Platform']);
    await syncUserTeams(userId, ['Platform']);

    expect(await membershipsOf(userId)).toEqual(['Platform']);
  });
});
