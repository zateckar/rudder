/**
 * Turning an identity provider's group claim into team memberships.
 *
 * This lives here rather than beside the callback that calls it because a
 * SvelteKit `+server.ts` may only export HTTP verbs — `vite build` rejects
 * anything else outright, and both of these need to be reachable from tests. The
 * route file was exporting `syncUserTeams` regardless, which is why the
 * production build failed while `bun test` and `svelte-check` were both clean.
 */
import { db } from '$lib/db';
import { teams, teamMembers } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

/** How the group claim is to be read. One mode or the other; suffix wins. */
export interface TeamClaimConfig {
  /** Exactly one key inside the claim object holds the list of team names. */
  teamClaimKey?: string | null;
  /** Every key ending in `.<suffix>` holds a list of team names. */
  teamRoleSuffix?: string | null;
}

export interface TeamClaimResolution {
  teamNames: string[];
  /**
   * Whether the claim was understood well enough to *remove* memberships with.
   *
   * False means "ask again next login", not "no teams" — see `syncUserTeams`.
   */
  resolved: boolean;
  /** Why it was not resolved, for the log. Absent when it was. */
  reason?: string;
}

const asStrings = (xs: unknown[]): string[] => xs.filter((x): x is string => typeof x === 'string');

/**
 * Whether `key` names the configured role.
 *
 * The keys of `apps_with_role` are `<app>.<role>` — `podp.admin` — so the role
 * is the segment after the last dot. A bare `admin` is accepted too, for a
 * provider that emits the role alone.
 */
function keyHasRoleSuffix(key: string, suffix: string): boolean {
  const lower = key.toLowerCase();
  return lower === suffix || lower.endsWith(`.${suffix}`);
}

/**
 * The team names a group claim asserts.
 *
 * A claim that is already a list of names is used as-is. An *object* claim needs
 * to be told which of its entries to read, and there are two ways to say so:
 *
 * - **Role suffix** (`teamRoleSuffix`). The claim this exists for is Keycloak's
 *   `apps_with_role`, which has one key per application the user holds a role
 *   in — `{"podp.admin": ["PODP"], "hmi.admin": ["HMI"]}`. Which applications
 *   those are is exactly what is not known in advance, so naming keys cannot
 *   work: the suffix names the *role* and every key carrying it contributes.
 * - **Exact key** (`teamClaimKey`), for a claim that nests one fixed list, e.g.
 *   `{"groups": [...]}`. The original mode, kept for configurations using it.
 *
 * Suffix wins if both are set — it is the more specific answer to "which entries
 * of this object are group lists", and having the key silently override it would
 * reinstate the single-application bug on any config that still has one saved.
 *
 * On an object claim both modes resolve even when they select nothing: the
 * provider sent the map and this user has no qualifying entry in it, which is a
 * user who holds the role nowhere and must lose the memberships it granted. What
 * does *not* resolve is a claim whose shape was not understood at all.
 */
export function resolveTeamNames(claimValue: unknown, cfg: TeamClaimConfig): TeamClaimResolution {
  if (claimValue === undefined || claimValue === null) {
    return { teamNames: [], resolved: false, reason: 'claim not present' };
  }

  if (Array.isArray(claimValue)) {
    return { teamNames: asStrings(claimValue), resolved: true };
  }

  if (typeof claimValue !== 'object') {
    return {
      teamNames: [],
      resolved: false,
      reason: `claim is a ${typeof claimValue}, not a list or an object`,
    };
  }

  const entries = Object.entries(claimValue as Record<string, unknown>);

  // A leading dot is what an operator copying `podp.admin` out of a token tends
  // to type, and it means the same thing here.
  const suffix = cfg.teamRoleSuffix?.trim().replace(/^\./, '').toLowerCase();
  if (suffix) {
    // Case-insensitively deduplicated: two applications can name the same team
    // ({"podp.admin": ["SHARED"], "hmi.admin": ["shared"]}), and `syncUserTeams`
    // would otherwise create a second team for the second spelling.
    const byNormalized = new Map<string, string>();
    for (const [key, value] of entries) {
      if (!keyHasRoleSuffix(key, suffix)) continue;
      if (!Array.isArray(value)) {
        console.warn(`[oidc/generic] Claim entry "${key}" is not a list; skipping it.`);
        continue;
      }
      for (const name of asStrings(value)) {
        if (!byNormalized.has(name.toLowerCase())) byNormalized.set(name.toLowerCase(), name);
      }
    }
    return { teamNames: [...byNormalized.values()], resolved: true };
  }

  if (cfg.teamClaimKey) {
    const value = (claimValue as Record<string, unknown>)[cfg.teamClaimKey];
    if (value === undefined || value === null) return { teamNames: [], resolved: true };
    if (!Array.isArray(value)) {
      return {
        teamNames: [],
        resolved: false,
        reason: `claim key "${cfg.teamClaimKey}" is not a list`,
      };
    }
    return { teamNames: asStrings(value), resolved: true };
  }

  return {
    teamNames: [],
    resolved: false,
    reason: 'claim is an object, but no team claim key or role suffix is configured',
  };
}

/** The slug a team name gets. Also how a claim is matched against existing slugs. */
function slugifyTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
}

/**
 * Make the user's team memberships match the claim, in both directions.
 *
 * This used only to add. A membership granted from an IdP group therefore
 * outlived removal from that group indefinitely: revoking someone's access in
 * the identity provider left their Rudder access exactly as it was, which is the
 * opposite of what configuring a team claim is for.
 *
 * So once a team claim is configured, the claim is authoritative for this user's
 * memberships, without exception: every row naming a team the claim does not is
 * removed. Nothing records where a membership came from, so that includes rows an
 * admin added by hand — for an account that signs in through the provider, the
 * provider decides, and a hand-grant lasts until their next login.
 *
 * There used to be one exception: an `owner` row survived, which was the only way
 * to pin a membership the claim would not name. That role is gone (teams are
 * flat), and with it the exception. An operator who needs a durable grant for an
 * OIDC account has to put it in the claim, which is the honest answer — the
 * previous one made the escape hatch a side effect of a permission tier.
 *
 * Only called when the claim actually resolved to a list — see the call site.
 * Treating an absent or malformed claim as "no teams" would turn one provider
 * misconfiguration into a mass revocation.
 */
export async function syncUserTeams(userId: string, teamNames: string[]): Promise<void> {
  const now = new Date();

  // Get existing teams, keyed the way group claims are matched: case-insensitively.
  //
  // `teams.name` is UNIQUE, but SQLite compares text case-sensitively without
  // COLLATE NOCASE, so "Platform" and "platform" can both exist. Building the
  // map by assignment let the last row win silently, which made a group claim
  // resolve to whichever of two case-variant teams happened to come back last —
  // renaming a team was enough to divert another team's OIDC members into it.
  //
  // `PATCH /api/teams/[id]` now rejects such a rename, but rows predating that
  // check can still be here, so ambiguity is detected rather than assumed away:
  // an ambiguous name is skipped below, leaving memberships untouched. Guessing
  // is the one thing this must not do.
  const existingTeams = await db.select().from(teams).all();
  type Team = typeof existingTeams[number];

  const existingTeamMap = new Map<string, Team>();
  const ambiguousNames = new Set<string>();
  for (const team of existingTeams) {
    const key = team.name.toLowerCase();
    if (existingTeamMap.has(key)) {
      ambiguousNames.add(key);
      continue;
    }
    existingTeamMap.set(key, team);
  }

  // The second way a claim can name a team Rudder already has: its slug.
  //
  // A group is `PODP` and the team an admin created for it is "Product Portal"
  // with slug `podp`. Matching on the display name alone missed that and created
  // a *second* team called PODP — empty, with none of the applications, quotas or
  // secrets of the real one, and with the user in it instead of where they
  // belong. Matching the slug too is what makes an existing team the default
  // outcome and creation the exception.
  //
  // Same ambiguity guard as names: `teams.slug` is UNIQUE, but SQLite compares
  // case-sensitively, so case-variant slugs are storable and must not be guessed
  // between.
  const teamsBySlug = new Map<string, Team>();
  const ambiguousSlugs = new Set<string>();
  for (const team of existingTeams) {
    const key = team.slug.toLowerCase();
    if (teamsBySlug.has(key)) {
      ambiguousSlugs.add(key);
      continue;
    }
    teamsBySlug.set(key, team);
  }

  // Slugs already spoken for. A team created below should not normally be able
  // to want one of these — a claim whose slug is taken matches that team instead
  // of creating anything — but `teams.slug` is UNIQUE and other code paths mint
  // slugs by their own rules, so the backstop is worth two lines: a violation
  // here would throw mid-login and abort the withdrawals further down with it.
  const usedSlugs = new Set(existingTeams.map((t) => t.slug.toLowerCase()));

  // Get user's current team memberships
  const currentMemberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
  const currentTeamIds = new Set(currentMemberships.map(m => m.teamId));

  // Determine teams to create and join
  const teamsToJoin: string[] = [];
  const claimedTeamIds = new Set<string>();
  // Names already handled this run, so a claim naming the same team twice — which
  // a role suffix makes easy, two applications mapping to one team — does not do
  // the work twice.
  const handledNames = new Set<string>();
  for (const rawName of teamNames) {
    // A provider that pads its group names must not produce a team called " PODP "
    // sitting next to the real one.
    const teamName = rawName.trim();
    if (!teamName) continue;

    const normalizedName = teamName.toLowerCase();
    if (handledNames.has(normalizedName)) continue;
    handledNames.add(normalizedName);

    if (ambiguousNames.has(normalizedName)) {
      // Two teams differ only by capitalisation, so this claim does not name one
      // team. Joining either could put the user in the wrong tenant.
      console.error(
        `[oidc/team-sync] Group "${teamName}" matches more than one team case-insensitively; ` +
          `skipping it. Rename one of the teams so the names differ by more than capitalisation.`,
      );
      continue;
    }

    const slug = slugifyTeamName(teamName);
    if (!existingTeamMap.has(normalizedName) && ambiguousSlugs.has(slug)) {
      console.error(
        `[oidc/team-sync] Group "${teamName}" matches the slug of more than one team; skipping ` +
          `it. Rename one of the teams so their slugs differ by more than capitalisation.`,
      );
      continue;
    }

    // Name first, slug second: the display name is what the claim most directly
    // names, and a team whose name matches is the one meant even if some other
    // team's slug happens to collide.
    const existing = existingTeamMap.get(normalizedName) ?? teamsBySlug.get(slug);
    if (existing) {
      claimedTeamIds.add(existing.id);
      if (!currentTeamIds.has(existing.id)) {
        teamsToJoin.push(existing.id);
      }
      continue;
    }

    // No team by that name or slug — create one.
    //
    // The slug is only suffixed when it has to be. It used to be suffixed
    // unconditionally (`podp-m1k2j3`), which made every sync-created team
    // unmatchable by slug on the next login and left the URL of a team named
    // after a group looking like a cache key.
    const teamId = crypto.randomUUID();
    const freeSlug = usedSlugs.has(slug) ? `${slug}-${Date.now().toString(36)}` : slug;
    await db.insert(teams).values({
      id: teamId,
      name: teamName,
      slug: freeSlug,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    usedSlugs.add(freeSlug);

    // Register it, so a later entry in the same claim that resolves here finds
    // this team instead of creating another.
    const created: Team = {
      id: teamId,
      name: teamName,
      slug: freeSlug,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    existingTeamMap.set(normalizedName, created);
    teamsBySlug.set(freeSlug, created);

    claimedTeamIds.add(teamId);
    teamsToJoin.push(teamId);
  }

  // Add user to new teams
  for (const teamId of teamsToJoin) {
    await db.insert(teamMembers).values({
      teamId,
      userId,
      joinedAt: now,
    }).onConflictDoNothing();
  }

  // Teams whose name or slug is ambiguous were skipped above, so the claim could
  // not confirm them. Withdrawing on that basis would turn "Rudder cannot tell
  // these two teams apart" into "the user loses access to both" — the same
  // fail-open-into-mass-revocation this function's contract rules out. They are
  // left exactly as they are until an operator renames one.
  const ambiguousTeamIds = new Set(
    existingTeams
      .filter(
        (t) => ambiguousNames.has(t.name.toLowerCase()) || ambiguousSlugs.has(t.slug.toLowerCase()),
      )
      .map((t) => t.id),
  );

  // Withdraw memberships the claim no longer asserts.
  for (const membership of currentMemberships) {
    if (claimedTeamIds.has(membership.teamId)) continue;
    if (ambiguousTeamIds.has(membership.teamId)) continue;
    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, membership.teamId)));
    console.log(`[oidc/generic] Removed membership of team ${membership.teamId} — not in claim`);
  }
}