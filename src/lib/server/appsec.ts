/**
 * Per-application AppSec rule exclusions.
 *
 * CrowdSec's CRS is scored, not signature-matched: a request accumulates points
 * from many rules and `949110` ("Inbound Anomaly Score Exceeded") is what
 * actually fires. Applications with legitimately odd-looking traffic cross that
 * threshold on ordinary work. Two observed on a production worker:
 *
 *   ProjectSend  /uploads/<uuid>/parts/1?expires=…&signature=<64 hex>
 *   versitygw    /list-buckets, /list-users, /create-user
 *
 * The signature and the S3 admin paths trip the shell-expression (932xxx), SQLi
 * (942xxx) and PHP-injection (933180) regexes. Out-of-band, so nothing is
 * blocked inline — but `crowdsecurity/crowdsec-appsec-outofband` turns repeats
 * into a ban, and a ban is by source address across the whole worker. A user
 * uploading a file loses every application on that host.
 *
 * So exclusions are per-application and keyed on the request's Host, which is
 * the only thing AppSec sees that identifies the application. Deliberately not
 * keyed on the port: the first version of this analysis assumed the extra
 * entryPoints were to blame and was wrong — the worst offender was an ordinary
 * application on 443.
 */

import { TAG_PREFIX, firstRuleRefusal, metaRuleNote, tagOf } from '$lib/appsec-rules';

/**
 * One entry in an application's exclusion list. Three kinds, deliberately kept
 * apart because CrowdSec needs a different removal helper for each:
 *
 *   `942100`                            a CRS rule id
 *   `tag:attack-lfi`                    every rule in an attack class
 *   `crowdsecurity/vpatch-git-config`   a CrowdSec rule name
 */
export type AppsecRuleId = number | string;

/**
 * Why this rule list may not be saved, or null when it may.
 *
 * Every write path calls this: both application forms, the kubectl annotation
 * and the one-click exclude on the worker page. Excluding the anomaly gate is
 * not a narrower ruleset, it is no ruleset, and the point of the feature is to
 * give up the least protection that solves the problem.
 */
export function appsecRuleError(rules: AppsecRuleId[]): string | null {
  return firstRuleRefusal(rules);
}

export const APPSEC_RULES_ERROR =
  'Disabled WAF rules must be a comma-separated list of CRS rule numbers (for example 942100), ' +
  'attack-class tags (for example tag:attack-lfi), or CrowdSec rule names (for example ' +
  'crowdsecurity/vpatch-git-config).';

/**
 * Hub rule names and tag values: the character set CrowdSec itself uses.
 *
 * The same shape serves both — `crowdsecurity/vpatch-git-config` and
 * `capec/1000/255/153/126` are indistinguishable, which is why a tag is marked
 * by an explicit `tag:` prefix rather than guessed at.
 */
const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Hostnames Rudder routes. Anything else never reaches the generated filter. */
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * `"942100, crowdsecurity/vpatch-git-config"` → the two ids, or null if the
 * value is not a rule list at all.
 *
 * Null is a rejection the form reports, not a silent empty: reading a typo as
 * "exclude nothing" would leave someone believing they had switched a rule off.
 */
export function parseRuleList(value: string): AppsecRuleId[] | null {
  const trimmed = value.trim();
  if (trimmed === '') return [];

  const rules: AppsecRuleId[] = [];
  for (const part of trimmed.split(',').map((p) => p.trim())) {
    if (part === '') continue;
    if (/^\d+$/.test(part)) {
      const id = Number(part);
      // CRS ids are six digits; the bound is a sanity check, not a schema.
      if (id < 1 || id > 999_999_999) return null;
      if (!rules.includes(id)) rules.push(id);
      continue;
    }
    // `tag:attack-lfi` — one entry standing for a whole attack class, which
    // keeps working when CRS adds a rule to that class where a list of ids
    // would silently stop covering it.
    const tag = tagOf(part);
    if (tag !== null) {
      if (!RULE_NAME.test(tag)) return null;
      const normalised = `${TAG_PREFIX}${tag}`;
      if (!rules.includes(normalised)) rules.push(normalised);
      continue;
    }
    if (!RULE_NAME.test(part)) return null;
    if (!rules.includes(part)) rules.push(part);
  }
  return rules;
}

/**
 * The stored column as a rule list.
 *
 * Tolerant on purpose: this value reaches the worker configuration generator,
 * and a row holding something unexpected must degrade to "no exclusions" — the
 * fully-protected default — rather than throw. Failing open here would mean a
 * malformed row silently disables the WAF for an application.
 */
export function parseAppsecRules(stored: string | null | undefined): AppsecRuleId[] {
  if (stored === null || stored === undefined || stored.trim() === '') return [];
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const rules: AppsecRuleId[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) {
        if (!rules.includes(entry)) rules.push(entry);
      } else if (typeof entry === 'string') {
        const value = entry.trim();
        const tag = tagOf(value);
        const usable = tag !== null ? RULE_NAME.test(tag) : RULE_NAME.test(value);
        if (usable && !rules.includes(value)) rules.push(value);
      }
    }
    return rules;
  } catch {
    return [];
  }
}

/** The list as the column stores it. Null when nothing is excluded. */
export function serializeAppsecRules(rules: AppsecRuleId[] | null | undefined): string | null {
  if (rules === null || rules === undefined || rules.length === 0) return null;
  return JSON.stringify(rules);
}

/** One application's exclusions. */
export interface AppsecExclusion {
  /** The public hostname Traefik routes this application on. */
  host: string;
  rules: AppsecRuleId[];
}

/** The name the acquisition references this generated config by. */
export const APPSEC_CONFIG_NAME = 'rudder/exclusions';

/**
 * The `pre_eval` filter for one host.
 *
 * `req.Host` carries the port when the request came in on an entryPoint other
 * than 443 — `versity.example.com:1443` — because that is what the client sent
 * in the Host header. Matching only the bare name would silently fail to
 * exclude anything on ports 1443-4443, which is where the API traffic that
 * needs excluding mostly lives.
 */
function hostFilter(host: string): string {
  return `req.Host == '${host}' || req.Host startsWith '${host}:'`;
}

/**
 * A CrowdSec AppSec configuration that removes the listed rules per host.
 *
 * Loaded alongside `crowdsecurity/appsec-default` and `crowdsecurity/crs`
 * rather than replacing them: the acquisition's `appsec_configs` is a list and
 * the entries merge, so the hub configs keep tracking upstream and this one
 * only contributes hooks. Reproducing their rule lists here would fork them
 * silently the first time CrowdSec updated either.
 *
 * Rules are removed from both the in-band and out-of-band engines. A rule that
 * is not loaded in one of them is not an error for CrowdSec, and an operator
 * excluding `942100` means "stop this firing for my application", not "stop it
 * firing out-of-band specifically".
 */
export function generateAppsecConfig(exclusions: AppsecExclusion[]): string {
  const lines: string[] = [
    '# Generated by Rudder. Do not edit on the worker — it is overwritten on',
    '# every configuration fetch. Change the disabled rules on the application.',
    '#',
    '# Removes named rules for one application only, matched on the request Host.',
    '# Everything not listed here keeps the full ruleset.',
    `name: ${APPSEC_CONFIG_NAME}`,
    'default_remediation: ban',
  ];

  // Meta rules are dropped here as well as refused at every write path.
  //
  // Belt and braces on purpose: this function decides what the WAF actually
  // does, and one row holding `949110` — hand-edited, restored from a backup
  // taken before the refusal existed, written by some future caller that forgets
  // to validate — would silently disable CRS for that application. The
  // validation gives a person a useful error; this makes the bad state
  // unreachable.
  const usable = exclusions
    .map((e) => ({ ...e, rules: e.rules.filter((r) => !metaRuleNote(r)) }))
    .filter((e) => e.rules.length > 0 && HOSTNAME.test(e.host) && e.host.length <= 253);

  if (usable.length === 0) {
    // A config with no hooks is valid and loads cleanly. Emitting the file
    // unconditionally keeps the acquisition's reference to it resolvable, so a
    // worker that has just had its last exclusion removed does not fail to
    // start AppSec at all.
    lines.push('# No application has disabled any rule on this worker.');
    return lines.join('\n') + '\n';
  }

  lines.push('pre_eval:');
  for (const { host, rules } of usable) {
    lines.push(`  # ${host}`);
    lines.push(`  - filter: "${hostFilter(host)}"`);
    lines.push('    apply:');
    for (const rule of rules) {
      if (typeof rule === 'number') {
        lines.push(`      - RemoveInBandRuleByID(${rule})`);
        lines.push(`      - RemoveOutBandRuleByID(${rule})`);
        continue;
      }
      // A tag stands for a whole attack class. Verified on a live worker:
      // `RemoveOutBandRuleByTag("attack-lfi")` took 930100, 930110 and 930120
      // out of the match and left the RCE and SQLi rules firing. It also keeps
      // working when CRS adds a fourth LFI rule, where a list of ids would
      // quietly stop covering the class.
      const tag = tagOf(rule);
      if (tag !== null) {
        lines.push(`      - RemoveInBandRuleByTag("${tag}")`);
        lines.push(`      - RemoveOutBandRuleByTag("${tag}")`);
        continue;
      }
      lines.push(`      - RemoveInBandRuleByName("${rule}")`);
      lines.push(`      - RemoveOutBandRuleByName("${rule}")`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Every exclusion that applies on one worker.
 *
 * Read from `applications`, not from `containers`: an application whose
 * containers are between generations still has a hostname, and an exclusion
 * that vanished mid-deploy would ban whoever was using it at the time. Routing
 * cares which containers are live; AppSec does not.
 */
export async function appsecExclusionsForWorker(workerId: string): Promise<AppsecExclusion[]> {
  // Lazily imported so the generators above stay usable from tests and from
  // modules that must not open the database — the same reason
  // `routeGroupsForWorker` does it.
  const [{ db }, { applications }, { eq }] = await Promise.all([
    import('$lib/db'),
    import('$lib/db/schema'),
    import('drizzle-orm'),
  ]);

  const rows = await db
    .select({ domain: applications.domain, rules: applications.appsecDisabledRules })
    .from(applications)
    .where(eq(applications.workerId, workerId))
    .all();

  const exclusions: AppsecExclusion[] = [];
  for (const row of rows) {
    if (!row.domain) continue;
    const rules = parseAppsecRules(row.rules);
    if (rules.length === 0) continue;
    exclusions.push({ host: row.domain, rules });
  }

  // Sorted so the generated document is stable: the worker compares it against
  // the installed one and restarts CrowdSec on any difference. Row order from
  // SQLite is not guaranteed, and an unstable document would restart the WAF on
  // every poll.
  return exclusions.sort((a, b) => a.host.localeCompare(b.host));
}
