/**
 * Reading team names out of a group claim.
 *
 * The claim this was written against is Keycloak's `apps_with_role`, which has
 * one key per application the user holds a role in:
 *
 *   "apps_with_role": { "podp.admin": ["PODP"] }
 *
 * Configuring one exact key therefore only ever worked for one application, and
 * which applications a user has is precisely what cannot be known in advance —
 * hence the role suffix. The other half of what is pinned down here is *when the
 * result may be used to revoke*: an unreadable claim must change nothing, an
 * understood-but-empty one must withdraw.
 */
import { describe, expect, test } from 'bun:test';
import { resolveTeamNames } from '$lib/server/oidc-teams';

describe('resolveTeamNames — the claim is already a list', () => {
  test('uses it as-is, no key or suffix needed', () => {
    expect(resolveTeamNames(['Platform', 'Payments'], {})).toEqual({
      teamNames: ['Platform', 'Payments'],
      resolved: true,
    });
  });

  test('drops non-string entries rather than rejecting the claim', () => {
    expect(resolveTeamNames(['Platform', 42, null], {}).teamNames).toEqual(['Platform']);
  });

  test('an empty list resolves — that is a user in no groups', () => {
    expect(resolveTeamNames([], {})).toEqual({ teamNames: [], resolved: true });
  });
});

describe('resolveTeamNames — role suffix', () => {
  const claim = {
    'podp.admin': ['PODP'],
    'hmi.admin': ['HMI'],
    'podp.user': ['PODP-READONLY'],
  };

  test('collects every application whose key carries the role', () => {
    // The bug this exists for: with `teamClaimKey: 'podp.admin'` the same token
    // grants PODP and silently drops HMI.
    expect(resolveTeamNames(claim, { teamRoleSuffix: 'admin' })).toEqual({
      teamNames: ['PODP', 'HMI'],
      resolved: true,
    });
  });

  test('one application granting several teams yields all of them', () => {
    // The value is a list, not a single name: one role in one application can map
    // to more than one team.
    const many = { 'podp.admin': ['PODP', 'PODP-STAGING', 'PODP-TOOLS'] };
    expect(resolveTeamNames(many, { teamRoleSuffix: 'admin' }).teamNames).toEqual([
      'PODP',
      'PODP-STAGING',
      'PODP-TOOLS',
    ]);
  });

  test('several applications and several teams each, all unioned', () => {
    const many = { 'podp.admin': ['PODP', 'PODP-TOOLS'], 'hmi.admin': ['HMI'] };
    expect(resolveTeamNames(many, { teamRoleSuffix: 'admin' }).teamNames).toEqual([
      'PODP',
      'PODP-TOOLS',
      'HMI',
    ]);
  });

  test('a different suffix selects a different set', () => {
    expect(resolveTeamNames(claim, { teamRoleSuffix: 'user' }).teamNames).toEqual(['PODP-READONLY']);
  });

  test('the suffix is matched case-insensitively', () => {
    // Tokens spell the role both ways — `roles: ["PODP.ADMIN"]` next to
    // `apps_with_role: {"podp.admin": …}` — so neither spelling may be the wrong
    // thing to type into the settings form.
    expect(resolveTeamNames(claim, { teamRoleSuffix: 'ADMIN' }).teamNames).toEqual(['PODP', 'HMI']);
    expect(resolveTeamNames({ 'PODP.ADMIN': ['PODP'] }, { teamRoleSuffix: 'admin' }).teamNames)
      .toEqual(['PODP']);
  });

  test('a leading dot is tolerated', () => {
    // What an operator copying `.admin` out of a key tends to type.
    expect(resolveTeamNames(claim, { teamRoleSuffix: '.admin' }).teamNames).toEqual(['PODP', 'HMI']);
  });

  test('a bare key equal to the suffix matches', () => {
    expect(resolveTeamNames({ admin: ['PODP'] }, { teamRoleSuffix: 'admin' }).teamNames)
      .toEqual(['PODP']);
  });

  test('a key that merely ends in the letters does not match', () => {
    // `sysadmin` is not the `admin` role of an application called `sys`.
    expect(resolveTeamNames({ sysadmin: ['ROOT'] }, { teamRoleSuffix: 'admin' }).teamNames)
      .toEqual([]);
  });

  test('deduplicates two applications naming one team, case-insensitively', () => {
    // Left in, this makes `syncUserTeams` create a second team under the second
    // spelling: its lookup map is built once, before the loop.
    const shared = { 'podp.admin': ['SHARED'], 'hmi.admin': ['shared'] };
    expect(resolveTeamNames(shared, { teamRoleSuffix: 'admin' }).teamNames).toEqual(['SHARED']);
  });

  test('no key carries the role — resolved, so the memberships it granted go', () => {
    // A user whose admin role was revoked everywhere. The provider sent the map;
    // this user is simply not in it.
    expect(resolveTeamNames({ 'podp.user': ['PODP'] }, { teamRoleSuffix: 'admin' })).toEqual({
      teamNames: [],
      resolved: true,
    });
  });

  test('skips an entry that is not a list, keeping the ones that are', () => {
    const mixed = { 'podp.admin': ['PODP'], 'hmi.admin': 'HMI' };
    expect(resolveTeamNames(mixed, { teamRoleSuffix: 'admin' })).toEqual({
      teamNames: ['PODP'],
      resolved: true,
    });
  });

  test('wins over a key left over from an earlier configuration', () => {
    // Otherwise saving a suffix would appear to do nothing on exactly the
    // deployments that already hit the single-application bug.
    const cfg = { teamRoleSuffix: 'admin', teamClaimKey: 'podp.admin' };
    expect(resolveTeamNames(claim, cfg).teamNames).toEqual(['PODP', 'HMI']);
  });

  test('a blank suffix is not a suffix', () => {
    const cfg = { teamRoleSuffix: '   ', teamClaimKey: 'podp.admin' };
    expect(resolveTeamNames(claim, cfg).teamNames).toEqual(['PODP']);
  });
});

describe('resolveTeamNames — exact key', () => {
  test('reads the one list it names', () => {
    const claim = { groups: ['Platform'], other: ['Payments'] };
    expect(resolveTeamNames(claim, { teamClaimKey: 'groups' })).toEqual({
      teamNames: ['Platform'],
      resolved: true,
    });
  });

  test('the key being absent resolves to no teams, not to "leave it alone"', () => {
    // The provider sent the object and this user has no entry under the key —
    // which is what losing the group looks like, and must revoke.
    expect(resolveTeamNames({ other: ['Payments'] }, { teamClaimKey: 'groups' })).toEqual({
      teamNames: [],
      resolved: true,
    });
  });

  test('the key holding something other than a list does not resolve', () => {
    const resolution = resolveTeamNames({ groups: 'Platform' }, { teamClaimKey: 'groups' });
    expect(resolution.resolved).toBe(false);
    expect(resolution.teamNames).toEqual([]);
  });
});

describe('resolveTeamNames — claims that must not revoke', () => {
  test('a claim the provider did not send', () => {
    expect(resolveTeamNames(undefined, { teamRoleSuffix: 'admin' }).resolved).toBe(false);
    expect(resolveTeamNames(null, { teamRoleSuffix: 'admin' }).resolved).toBe(false);
  });

  test('a scalar claim', () => {
    expect(resolveTeamNames('Platform', {}).resolved).toBe(false);
  });

  test('an object claim with neither a key nor a suffix configured', () => {
    // Nothing says which entries are group lists, so nothing is known — as
    // opposed to "known to be none".
    const resolution = resolveTeamNames({ 'podp.admin': ['PODP'] }, {});
    expect(resolution.resolved).toBe(false);
    expect(resolution.teamNames).toEqual([]);
  });
});
