/**
 * Which teams an MCP access token speaks for.
 *
 * The identity provider expresses "this client may act for team X" as an
 * audience: each Keycloak client that should reach Rudder is named
 * `<team>_<random>` and appears in the token's `aud` claim. The part before the
 * first underscore is the team; the rest only exists to make the client id
 * unique and is ignored.
 *
 * A team the provider names but Rudder does not have yet is created on first
 * use. That is the same rule the login-time group sync follows (see
 * oidc-teams.ts), and the same matching: an existing team is found by name or by
 * slug, case-insensitively, before anything is created — so the audience
 * `podp_x7f2` reaches the team an admin created as "Product Portal" with slug
 * `podp`, rather than a second, empty "podp" next to it.
 */
import { db } from '#lib/db/index.ts';
import { teams } from '#lib/db/schema.ts';

export type Team = typeof teams.$inferSelect;

/** The `aud` claim as a list. RFC 7519 allows a single string or an array. */
export function audienceList(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === 'string');
  return [];
}

/**
 * The team an audience names, or null when it is not team-shaped.
 *
 * `podp_x7f2` → `podp`. An audience with no underscore (Keycloak adds `account`
 * to most tokens) or with nothing before it names no team and is skipped.
 */
export function teamNameFromAudience(audience: string): string | null {
  const index = audience.indexOf('_');
  if (index <= 0) return null;
  const name = audience.slice(0, index).trim();
  return name || null;
}

/** Team names in `aud`, deduplicated case-insensitively, first spelling kept. */
export function teamNamesFromAudience(aud: unknown): string[] {
  const byKey = new Map<string, string>();
  for (const audience of audienceList(aud)) {
    const name = teamNameFromAudience(audience);
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()];
}

/** Same rule as the login-time group sync, so both find the same team. */
export function slugifyTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
}

export interface TeamResolution {
  teams: Team[];
  /** Teams that did not exist and were created for this token. */
  created: Team[];
  /** Names that could not be mapped to exactly one team, and why. */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Find — or create — the team for each name.
 *
 * One synchronous transaction (bun:sqlite), so two concurrent first requests for
 * a new team cannot both decide to create it. A name matching more than one team
 * case-insensitively is skipped rather than guessed between: guessing would put
 * the caller in someone else's tenant.
 */
export function resolveTeams(names: readonly string[]): TeamResolution {
  if (names.length === 0) return { teams: [], created: [], skipped: [] };

  return db.transaction((tx) => {
    const existing = tx.select().from(teams).all();
    const byName = new Map<string, Team[]>();
    const bySlug = new Map<string, Team[]>();
    for (const team of existing) {
      const n = team.name.toLowerCase();
      const s = team.slug.toLowerCase();
      byName.set(n, [...(byName.get(n) ?? []), team]);
      bySlug.set(s, [...(bySlug.get(s) ?? []), team]);
    }
    const usedSlugs = new Set(existing.map((t) => t.slug.toLowerCase()));

    const result: TeamResolution = { teams: [], created: [], skipped: [] };
    const seen = new Set<string>();

    for (const name of names) {
      const key = name.toLowerCase();
      const slug = slugifyTeamName(name);

      // Name first, slug second — as in syncUserTeams.
      const nameMatches = byName.get(key) ?? [];
      const candidates = nameMatches.length > 0 ? nameMatches : (bySlug.get(slug) ?? []);
      if (candidates.length > 1) {
        result.skipped.push({
          name,
          reason: 'matches more than one team case-insensitively; rename one of them',
        });
        continue;
      }
      if (candidates.length === 1) {
        if (!seen.has(candidates[0].id)) result.teams.push(candidates[0]);
        seen.add(candidates[0].id);
        continue;
      }

      if (!slug.replace(/-/g, '')) {
        result.skipped.push({ name, reason: 'does not produce a usable team slug' });
        continue;
      }

      const now = new Date();
      const team: Team = {
        id: crypto.randomUUID(),
        name,
        slug: usedSlugs.has(slug) ? `${slug}-${Date.now().toString(36)}` : slug,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(teams).values(team).run();
      usedSlugs.add(team.slug.toLowerCase());
      byName.set(key, [team]);
      bySlug.set(team.slug.toLowerCase(), [team]);
      seen.add(team.id);
      result.teams.push(team);
      result.created.push(team);
    }

    return result;
  });
}
