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

/**
 * A CRS numeric id (`942100`) or a CrowdSec rule name
 * (`crowdsecurity/vpatch-git-config`). Both appear in real alerts, and the two
 * need different removal helpers, so the distinction is kept rather than
 * normalised away.
 */
export type AppsecRuleId = number | string;

export const APPSEC_RULES_ERROR =
  'Disabled WAF rules must be a comma-separated list of CRS rule numbers (for example 942100) ' +
  'or CrowdSec rule names (for example crowdsecurity/vpatch-git-config).';

/** Hub rule names: the character set CrowdSec itself uses for hub items. */
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
      } else if (typeof entry === 'string' && RULE_NAME.test(entry.trim())) {
        const name = entry.trim();
        if (!rules.includes(name)) rules.push(name);
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

  const usable = exclusions.filter(
    (e) => e.rules.length > 0 && HOSTNAME.test(e.host) && e.host.length <= 253,
  );

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
      } else {
        lines.push(`      - RemoveInBandRuleByName("${rule}")`);
        lines.push(`      - RemoveOutBandRuleByName("${rule}")`);
      }
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
