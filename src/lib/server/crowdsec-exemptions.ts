/**
 * Worker-level CrowdSec exemptions — addresses no scenario may ban.
 *
 * Rule exclusions ([appsec.ts]) answer "this CRS rule misfires on my
 * application". They cannot answer the other half of the problem, which is what
 * this module is for: **most bans on a busy worker do not come from AppSec at
 * all.** They come from log-derived scenarios reading Traefik's access log —
 * `crowdsecurity/http-probing` on a run of 404s, `LePresidente/http-generic-403-bf`
 * on a run of 403s — and those have no rule id, no Host to attribute them to,
 * and nothing an exclusion can remove.
 *
 * Confirmed in production on 2026-09-14, in both directions at once. An API
 * gateway tester on one worker calls a gateway on another; the gateway's worker
 * banned the caller, so every call 403'd; **those 403s then fed
 * `http-generic-403-bf`, which re-banned the caller** — 32 live decisions on one
 * address, regenerating faster than anyone could lift them. A rule exclusion had
 * been applied and correctly changed nothing, because no rule was involved. The
 * ban survived every attempt to remove the decision and only stopped when the
 * address was allowlisted.
 *
 * So an exemption is deliberately *not* per-rule and *not* per-application: it
 * says "this address is ours, never ban it", which is the only statement that
 * survives a scenario nobody has met yet. That is also its cost — one address
 * exempted is every application on the worker exposed to it — which is why the
 * UI states it and why the wide ranges are refused below.
 *
 * Implemented with CrowdSec's own allowlists rather than a Rudder-generated
 * file, for one deciding reason: allowlists are consulted when a decision is
 * *created*, so an exemption stops the loop at its source instead of racing it.
 * Adding one also deletes the decisions that already match — `cscli` reports
 * `32 decisions deleted by allowlists`, verified on a live worker — which is the
 * difference between this and lifting bans by hand while they re-appear.
 */

import { isSourceRange, isValidSource } from '$lib/appsec-rules';

/**
 * The allowlist Rudder manages, by name.
 *
 * Named rather than reused: a worker may have allowlists an operator made by
 * hand, and Rudder removing entries it did not add would be a surprise with a
 * security consequence. Everything here is scoped to this one list.
 */
export const EXEMPTION_LIST = 'rudder-exemptions';

/** What the list is created with, so `cscli allowlists list` explains itself. */
export const EXEMPTION_LIST_DESCRIPTION =
  'Addresses exempted from CrowdSec decisions, managed by Rudder';

/** One exempted address. */
export interface CrowdsecExemption {
  /** An address or CIDR range. */
  value: string;
  /** Why it is exempt — free text, and the only record of intent. */
  comment: string;
  /** When it was added, ISO, or '' when CrowdSec did not say. */
  createdAt: string;
  /**
   * When it lapses, ISO, or '' for never.
   *
   * CrowdSec writes `0001-01-01T00:00:00Z` for an entry with no expiry. Passing
   * that through would render as the year 1 and read as "expired long ago",
   * which is the opposite of what it means.
   */
  expiresAt: string;
}

/** CrowdSec's zero time, which is how it spells "no expiry". */
const NEVER = /^0001-01-01T/;

/**
 * The narrowest prefix Rudder will accept, per family.
 *
 * An exemption is already the bluntest control here; a wide one is not a blunt
 * control but the absence of one. `0.0.0.0/0` allowlists the internet — it
 * switches CrowdSec off for the worker while looking like an ordinary row in a
 * table, which is the same trap as excluding rule 949110 and is refused for the
 * same reason. The bounds are drawn where a plausible operator intent stops: a
 * corporate egress range is a /16 or narrower, and an IPv6 site is a /48, so
 * anything wider is far likelier to be a mistake than a decision.
 */
const MIN_PREFIX_V4 = 16;
const MIN_PREFIX_V6 = 32;

/** Longest a comment may be, so one row cannot break the table. */
export const EXEMPTION_COMMENT_MAX = 200;

/**
 * Why this address may not be exempted, or null when it may.
 *
 * Refused rather than warned about, matching `ruleExclusionRefusal`: a dialog
 * standing between someone and the thing they came to click is a dialog they
 * dismiss, and the mistakes this catches are silent ones.
 */
export function exemptionRefusal(value: string): string | null {
  const entry = value.trim();
  if (entry === '') return 'An exemption needs an address.';

  if (!isValidSource(entry)) {
    return (
      `"${entry}" is not an address or range. Exempt a single address such as 203.0.113.4, ` +
      `or a range such as 203.0.113.0/24.`
    );
  }

  if (!isSourceRange(entry)) return null;

  const [addr, bits] = entry.split('/');
  const prefix = Number(bits);
  const isV6 = addr.includes(':');
  const floor = isV6 ? MIN_PREFIX_V6 : MIN_PREFIX_V4;

  if (prefix < floor) {
    // Named as what it does rather than as a limit that was hit. "Prefix too
    // short" tells an operator they typed a number this code dislikes; the size
    // of the hole tells them why they should not want to.
    const scope = prefix === 0 ? 'every address on the internet' : 'a very large part of the internet';
    return (
      `Range ${entry} cannot be exempted: it covers ${scope}, so it would switch CrowdSec off ` +
      `for every application on this worker rather than exempt a caller. Exempt the addresses ` +
      `your own systems actually use — /${floor} or narrower for ` +
      `${isV6 ? 'IPv6' : 'IPv4'}.`
    );
  }

  return null;
}

/** The comment, trimmed to something a table can hold. */
export function normaliseComment(comment: string | null | undefined): string {
  return (comment ?? '').trim().replace(/\s+/g, ' ').slice(0, EXEMPTION_COMMENT_MAX);
}

/**
 * `cscli allowlists inspect <name> -o json` as exemptions, or null for no answer.
 *
 * Null and `[]` are kept apart for the reason they are in `parseDecisions`: an
 * empty list is an answer meaning none, and rendering an unanswered question as
 * "no exemptions" invites someone to add one that is already there — or worse,
 * to conclude a caller is unprotected when it is exempt.
 */
export function parseExemptions(stdout: string, exitCode: number): CrowdsecExemption[] | null {
  if (exitCode !== 0) return null;

  const text = stdout.trim();
  if (text === '' || text === 'null') return [];

  try {
    const parsed = JSON.parse(text);
    // A single object with `items`, which is what `inspect` returns. Anything
    // else is a shape this function does not know and must not guess at.
    const items = Array.isArray(parsed?.items) ? parsed.items : null;
    if (items === null) return null;

    const rows: CrowdsecExemption[] = [];
    for (const item of items) {
      const value = String(item?.value ?? '').trim();
      if (!value) continue;
      const expiration = String(item?.expiration ?? '');
      rows.push({
        value,
        comment: String(item?.description ?? ''),
        createdAt: String(item?.created_at ?? ''),
        expiresAt: NEVER.test(expiration) ? '' : expiration,
      });
    }
    // Stable order, so the table does not shuffle between polls.
    return rows.sort((a, b) => a.value.localeCompare(b.value));
  } catch {
    return null;
  }
}

/** What one attempt to read the exemptions produced. */
export interface ExemptionsRead {
  exemptions: CrowdsecExemption[];
  /** Why there is no answer, or null when there is one — including "none". */
  error: string | null;
}

/**
 * Whether `cscli` failed because the list has never been created.
 *
 * **This is an answer, not a failure.** A worker nobody has exempted anything on
 * has no `rudder-exemptions` list at all, and `cscli allowlists inspect` exits 1
 * with `allowlist 'rudder-exemptions' not found`. Reporting that as "could not
 * read exemptions" would put a red error on the tab of every worker in the
 * normal state, which is the surest way to teach people to ignore it.
 */
function listMissing(text: string): boolean {
  return /allowlist .*not found/i.test(text);
}

/** The first line of `cscli`'s complaint, trimmed to something renderable. */
function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300);
}

/** Judge one `cscli allowlists inspect` run. */
export function exemptionsFromExec(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  exitCodeKnown?: boolean;
  exitCodeError?: string | null;
}): ExemptionsRead {
  const { stdout, stderr, exitCode } = result;
  const exitCodeKnown = result.exitCodeKnown ?? true;

  if (listMissing(stderr) || listMissing(stdout)) {
    return { exemptions: [], error: null };
  }

  if (exitCodeKnown && exitCode !== 0) {
    const said = firstLine(stderr) || firstLine(stdout);
    return {
      exemptions: [],
      error: said
        ? `CrowdSec could not list exemptions: ${said}`
        : `CrowdSec exited ${exitCode} without explaining why.`,
    };
  }

  // Nothing printed and no confirmed status: nothing was learned. Parsing that
  // to `[]` would render as "no exemptions" on a worker that may have several.
  if (!exitCodeKnown && stdout.trim() === '') {
    const detail = result.exitCodeError ? ` (${firstLine(result.exitCodeError)})` : '';
    return {
      exemptions: [],
      error: `The worker never confirmed whether the query ran, and returned nothing${detail}.`,
    };
  }

  const parsed = parseExemptions(stdout, 0);
  if (parsed === null) {
    return {
      exemptions: [],
      error:
        `CrowdSec returned ${stdout.length} bytes that Rudder could not parse as an allowlist. ` +
        `This usually means cscli's output format has changed.`,
    };
  }

  return { exemptions: parsed, error: null };
}

/**
 * The commands that read, add and remove, in one place.
 *
 * Built here rather than inline at the call site so the list name cannot drift
 * between the four of them — an add against one name and a read against another
 * would look exactly like a write that silently did nothing.
 */
export const exemptionCommands = {
  read: (): string[] => ['cscli', 'allowlists', 'inspect', EXEMPTION_LIST, '-o', 'json'],
  create: (): string[] => [
    'cscli', 'allowlists', 'create', EXEMPTION_LIST, '-d', EXEMPTION_LIST_DESCRIPTION,
  ],
  add: (value: string, comment: string): string[] => {
    const cmd = ['cscli', 'allowlists', 'add', EXEMPTION_LIST, value];
    // Omitted rather than sent empty: `-d ''` records a blank description, and a
    // blank one is indistinguishable from an entry added by hand elsewhere.
    if (comment) cmd.push('-d', comment);
    return cmd;
  },
  remove: (value: string): string[] => ['cscli', 'allowlists', 'remove', EXEMPTION_LIST, value],
};

/**
 * Whether `cscli allowlists create` failed only because the list already exists.
 *
 * Create-then-add is run on every add, because the list is created lazily and
 * the first exemption on a worker would otherwise need two clicks with an error
 * between them. Every subsequent add therefore fails the create, and that
 * failure is the normal path rather than a problem to report.
 */
export function listAlreadyExists(result: { stdout: string; stderr: string }): boolean {
  return /already exist/i.test(`${result.stderr} ${result.stdout}`);
}

/**
 * How many decisions the add lifted, or null when `cscli` did not say.
 *
 * Worth surfacing rather than swallowing. Allowlisting an address deletes the
 * bans that already match it — on the live worker this feature came from, one
 * add reported `32 decisions deleted by allowlists`, which is the whole reason
 * the loop stopped. Telling the operator that number is the difference between
 * "saved" and evidence that the thing they were fighting is actually over.
 */
export function decisionsLifted(text: string): number | null {
  const m = /(\d+)\s+decisions?\s+deleted\s+by\s+allowlists/i.exec(text);
  return m ? Number(m[1]) : null;
}
