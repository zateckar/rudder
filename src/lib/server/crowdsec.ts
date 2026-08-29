/**
 * Reading and lifting the CrowdSec decisions on a worker.
 *
 * The LAPI listens on 127.0.0.1 on the worker and the control plane has no route
 * to it — but it does have an authenticated, mTLS-protected Podman API, and
 * running `cscli` inside the container is what an operator would do over SSH
 * anyway. So that is the transport.
 */

/** One row of `cscli decisions list -o json`, reduced to what the tab shows. */
export interface CrowdsecDecision {
  /**
   * The **decision** id, which is what `cscli decisions delete --id` takes.
   *
   * Not the alert id. They sit at different levels of the same document and are
   * both called `id`, so reading the outer one produces a plausible number that
   * deletes the wrong thing or nothing at all.
   */
  id: number;
  /** `crowdsec`, `cscli`, `CAPI`… — who decided. */
  source: string;
  /** `Ip`, `Range`, `Country`… */
  scope: string;
  value: string;
  /** The scenario that fired, e.g. `crowdsecurity/http-probing`. */
  reason: string;
  /** `ban`, `captcha`… */
  type: string;
  duration: string;
  /** Two-letter country of the source address, when CrowdSec resolved one. */
  country: string;
  /** Autonomous system name, e.g. `GOOGLE-CLOUD-PLATFORM`. */
  asName: string;
}

/** Alert-level fields worth carrying down onto each of its decisions. */
function alertContext(alert: any): { scope: string; value: string; country: string; asName: string } {
  const source = alert?.source ?? {};
  return {
    scope: String(source.scope ?? ''),
    value: String(source.value ?? source.ip ?? ''),
    country: String(source.cn ?? ''),
    asName: String(source.as_name ?? ''),
  };
}

/**
 * `cscli decisions list -o json` output as decisions, or null for no answer.
 *
 * **Null and `[]` are different facts and must stay so.** The CrowdSec tab used
 * to report an empty list unconditionally, which it rendered as "No active
 * decisions — all clear"; a worker with three live bans, one of them on the
 * operator reading the page, reported itself clear. An empty list is an answer
 * meaning none. Null is no answer, and the page has to say that instead.
 */
export function parseDecisions(stdout: string, exitCode: number): CrowdsecDecision[] | null {
  if (exitCode !== 0) return null;

  // `cscli` prints the JSON literal `null` when there is nothing to report,
  // which is a successful answer meaning "none" — not a failure to answer.
  const text = stdout.trim();
  if (text === '' || text === 'null') return [];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;

    // Despite the command's name, this is a list of *alerts*, each carrying the
    // decisions it produced. `scenario` exists at both levels, which is what made
    // the first version look half-right: Reason filled in while Source, Address,
    // Action and Expiry stayed blank, and the id it read was the alert's rather
    // than the decision's — a plausible number that deletes the wrong row.
    const rows: CrowdsecDecision[] = [];
    for (const alert of parsed) {
      const context = alertContext(alert);
      const nested = Array.isArray(alert?.decisions) ? alert.decisions : null;

      if (nested === null) {
        // Some `cscli` versions, and `-o json` on a decisions-only endpoint,
        // return the decisions flat. Recognised by shape rather than by version
        // so an upgrade cannot quietly empty this table.
        if (alert?.type === undefined && alert?.value === undefined) continue;
        rows.push(decisionRow(alert, context, alert?.scenario));
        continue;
      }

      // An alert with no decisions fired without banning anything: nothing to
      // show here and nothing to lift.
      for (const decision of nested) {
        rows.push(decisionRow(decision, context, alert?.scenario));
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * One decision as a row. Missing fields become blanks rather than dropping the
 * row — a decision that displays oddly is one somebody nonetheless has to see.
 */
function decisionRow(
  d: any,
  context: { scope: string; value: string; country: string; asName: string },
  alertScenario: unknown,
): CrowdsecDecision {
  return {
    id: Number(d?.id ?? 0),
    source: String(d?.origin ?? ''),
    // The decision's own scope/value when it has them; the alert's source
    // otherwise. They agree in practice, and the fallback is what keeps the
    // address column populated if that ever stops being true.
    scope: String(d?.scope ?? context.scope ?? ''),
    value: String(d?.value ?? context.value ?? ''),
    reason: String(d?.scenario ?? alertScenario ?? ''),
    type: String(d?.type ?? ''),
    duration: String(d?.duration ?? ''),
    country: context.country,
    asName: context.asName,
  };
}

/** What one attempt to read the decisions produced. */
export interface DecisionsRead {
  decisions: CrowdsecDecision[];
  /**
   * Why there is no answer, in words an operator can act on. Null when there
   * is one — including when the answer is legitimately "none".
   */
  error: string | null;
}

/** The first line of `cscli`'s complaint, trimmed to something renderable. */
function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300);
}

/**
 * Judge one `cscli decisions list` run.
 *
 * Split out from `parseDecisions` because the three ways this fails are three
 * different problems and the tab used to render all of them as one red sentence
 * with no detail: "could not read decisions". An operator seeing that
 * intermittently has nothing to report and nowhere to look — which is exactly
 * the position the last one was left in.
 */
export function decisionsFromExec(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  exitCodeKnown?: boolean;
  exitCodeError?: string | null;
}): DecisionsRead {
  const { stdout, stderr, exitCode } = result;
  const exitCodeKnown = result.exitCodeKnown ?? true;

  // cscli was asked and refused — a LAPI it cannot reach, a locked database.
  // Its own words are more use than anything this function could invent.
  if (exitCodeKnown && exitCode !== 0) {
    const said = firstLine(stderr) || firstLine(stdout);
    return {
      decisions: [],
      error: said
        ? `CrowdSec could not list decisions: ${said}`
        : `CrowdSec exited ${exitCode} without explaining why.`,
    };
  }

  // The status never came back *and* nothing was printed: nothing was learned.
  // Letting this through would parse to `[]` and render as "all clear", which
  // is the reassurance-without-an-answer bug all over again.
  if (!exitCodeKnown && stdout.trim() === '') {
    const detail = result.exitCodeError ? ` (${firstLine(result.exitCodeError)})` : '';
    return {
      decisions: [],
      error: `The worker never confirmed whether the query ran, and returned nothing${detail}.`,
    };
  }

  const parsed = parseDecisions(stdout, 0);
  if (parsed === null) {
    return {
      decisions: [],
      error:
        `CrowdSec returned ${stdout.length} bytes that Rudder could not parse as a decision list. ` +
        `This usually means cscli's output format has changed.`,
    };
  }

  return { decisions: parsed, error: null };
}

/**
 * One AppSec alert, reduced to what makes it actionable.
 *
 * The point of showing these is to answer "which rule broke my application" —
 * which a decision cannot answer, because the `rule_name` it carries is the
 * first id in the chain and is usually a CRS initialisation rule. `ruleIds` is
 * the real list.
 */
export interface CrowdsecAppsecAlert {
  /** The `Host` the request carried — this is what identifies the application. */
  host: string;
  uri: string;
  sourceIp: string;
  /** Every CRS rule that scored on this request, ascending. */
  ruleIds: number[];
  /**
   * What each rule is for, keyed by rule id — "Path Traversal Attack (/../)".
   *
   * The difference between a number somebody disables blind and a decision they
   * can actually make. Only one of the two alert shapes carries it.
   */
  ruleMessages: Record<string, string>;
  /**
   * CrowdSec hub rule names — `crowdsecurity/vpatch-git-config`.
   *
   * A list, because one request can trip several and because these are the
   * stable handle for rules whose numeric id is engine-internal. Held apart
   * from `ruleIds` since excluding one takes a different CrowdSec helper.
   */
  ruleNames: string[];
  /** Two-letter country of the source address, when CrowdSec resolved one. */
  country: string;
  asName: string;
  /** When CrowdSec raised this, ISO. Alerts are history, and it matters which. */
  at: string;
}

/** One rule, and how often it fired. */
export interface AppsecRuleCount {
  /** A CRS number, or a CrowdSec rule name for vpatch matches. */
  id: number | string;
  /** What the rule is for, when CrowdSec said. */
  message: string;
  /** Requests from this source that this rule matched. */
  count: number;
  /**
   * The hostnames this rule matched against, for this source.
   *
   * An exclusion has to name a host. One source commonly hits several
   * applications — a single group on a live worker covered versity on three
   * ports, projectsend, uptime-kuma and seatsurfing — so "which application"
   * cannot be answered at the group level, only per rule.
   */
  hosts: string[];
}

/**
 * Everything one source address tripped, with counts.
 *
 * Grouped by address because that is the unit a ban applies to: the question an
 * operator has is "who is being blocked and what set it off", and a flat list of
 * matches answers neither. Counts are the other half — a rule that fired ninety
 * times on one address is the one breaking that user's uploads, and a rule that
 * fired once alongside it is noise.
 */
export interface AppsecSourceGroup {
  sourceIp: string;
  country: string;
  asName: string;
  /** Requests from this address that matched anything. */
  requests: number;
  /** Hostnames this address hit. One, on an application's own page. */
  hosts: string[];
  /** Descending by count: the culprit first. */
  rules: AppsecRuleCount[];
  /** A few real paths, which is what says whether a match is legitimate. */
  paths: string[];
  /**
   * When this source was last seen, ISO, or '' when CrowdSec did not say.
   *
   * Shown because these are historical: "396 requests" with no time on it reads
   * as "right now", and on a live worker the traffic behind a number that size
   * had finished sixteen hours earlier.
   */
  lastSeen: string;
}

/** What happened to an address before now. */
export interface SourceBanHistory {
  /** When the most recent ban on it was created. */
  at: string;
  scenario: string;
  /** True when that ban has since run out — CrowdSec bans are time-limited. */
  expired: boolean;
}

/**
 * Bans that have already been and gone, by source address.
 *
 * Without this the matches table is quietly misleading. An address with four
 * hundred requests and no ban badge reads as "the WAF did nothing", when on a
 * live worker the truth was that CrowdSec banned it three times at 03:23 and
 * every one of those bans expired hours before anybody looked. Decisions are
 * live state; alerts are history; showing the two together with no time on
 * either invites exactly the wrong conclusion.
 *
 * Read from the same `cscli alerts list` output the matches come from, and
 * deliberately not restricted to AppSec alerts: what banned this address was
 * `http-probing` and friends, which are log-derived and would otherwise be
 * filtered out before anyone saw them.
 */
export function parseBanHistory(
  stdout: string,
  exitCode: number,
): Record<string, SourceBanHistory> | null {
  if (exitCode !== 0) return null;
  const text = stdout.trim();
  if (text === '' || text === 'null') return {};

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;

    const history: Record<string, SourceBanHistory> = {};
    for (const alert of parsed) {
      const decisions = Array.isArray(alert?.decisions) ? alert.decisions : [];
      // The community blocklist arrives as one alert carrying fifteen thousand
      // decisions for addresses that never touched this worker. Including it
      // would drown the handful that actually did something here.
      if (decisions.length > 50) continue;

      for (const decision of decisions) {
        const value = String(decision?.value ?? '');
        if (!value) continue;
        const at = String(alert?.created_at ?? '');
        const previous = history[value];
        if (previous && previous.at >= at) continue;
        history[value] = {
          at,
          scenario: String(decision?.scenario ?? alert?.scenario ?? ''),
          // `-13h51m41s` — CrowdSec counts down and keeps going once a ban has
          // run out, so a leading minus is what "expired" looks like.
          expired: String(decision?.duration ?? '').trim().startsWith('-'),
        };
      }
    }
    return history;
  } catch {
    return null;
  }
}

/** Every number in `[901340 911100 949110]`. CrowdSec formats it as a string. */
function parseRuleIds(raw: unknown): number[] {
  if (typeof raw !== 'string') return [];
  return [...raw.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** `native_rule:930100` → 930100, for anything else null. */
function nativeRuleId(name: string): number | null {
  const m = /^native_rule:(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * AppSec alerts from `cscli alerts list -a -o json`, or null for no answer.
 *
 * **CrowdSec emits two different shapes for these and both are common.** The
 * first version of this handled only one, and dropped the other silently:
 *
 *   `crowdsecurity/crowdsec-appsec-outofband` — one event carrying
 *   `datasource_type: appsec`, `target_host`, `target_uri` and the whole chain
 *   in a single `rule_ids` string.
 *
 *   `anomaly score out-of-band: lfi: 70, …` — one event *per rule*, with
 *   `target_fqdn`, `uri`, a `rule_name` of `native_rule:<id>`, a human `message`
 *   — and no `datasource_type` at all.
 *
 * Verified on two live workers: gamma had 5 of the first and 350+ of the
 * second, so filtering on `datasource_type` alone hid almost everything.
 *
 * Events are folded per alert and host, because the second shape means nine
 * events for one request and nine rows would be nine copies of one problem.
 * Log-derived scenarios like http-probing are excluded throughout: they have no
 * rule to disable and no Host to attribute it to, so offering the action would
 * be offering something that cannot work.
 */
export function parseAppsecAlerts(stdout: string, exitCode: number): CrowdsecAppsecAlert[] | null {
  if (exitCode !== 0) return null;
  const text = stdout.trim();
  if (text === '' || text === 'null') return [];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;

    const rows: CrowdsecAppsecAlert[] = [];

    for (const alert of parsed) {
      /** host → the one row that host contributes to this alert. */
      const byHost = new Map<string, CrowdsecAppsecAlert>();

      for (const event of Array.isArray(alert?.events) ? alert.events : []) {
        const meta: Record<string, string> = {};
        for (const m of Array.isArray(event?.meta) ? event.meta : []) {
          if (m?.key !== undefined) meta[String(m.key)] = String(m.value ?? '');
        }

        const host = meta.target_host || meta.target_fqdn || '';
        const ruleName = meta.rule_name ?? '';
        // Recognised by shape rather than by one field, since the field that
        // says "this is AppSec" is absent from the more common of the two.
        const isAppsec =
          meta.datasource_type === 'appsec' ||
          meta.service === 'appsec' ||
          meta.target_fqdn !== undefined ||
          nativeRuleId(ruleName) !== null;
        if (!isAppsec || !host) continue;

        const row: CrowdsecAppsecAlert = byHost.get(host) ?? {
          host,
          uri: '',
          sourceIp: meta.source_ip || alert?.source?.value || '',
          ruleIds: [],
          ruleMessages: {},
          ruleNames: [],
          country: String(alert?.source?.cn ?? ''),
          asName: String(alert?.source?.as_name ?? ''),
          at: String(alert?.created_at ?? ''),
        };

        // The longest URI wins: the per-rule shape repeats it on every event,
        // and a rule matching on a decoded fragment can report a shorter one.
        const uri = meta.target_uri || meta.uri || '';
        if (uri.length > row.uri.length) row.uri = uri;

        // A hub rule reports its own numeric id in `rule_ids` —
        // `crowdsecurity/vpatch-git-config` arrives as `[340322502]`. That is an
        // engine-internal id, opaque and unstable across hub updates, and
        // listing it as though it were a CRS rule offered an exclusion nobody
        // could evaluate and that would not survive an update. The name is the
        // stable handle, so for those events the name is all that is kept.
        const named = nativeRuleId(ruleName);
        const isHubRule = ruleName !== '' && named === null;
        const ids = isHubRule ? [] : parseRuleIds(meta.rule_ids);
        if (named !== null) ids.push(named);
        for (const id of ids) {
          if (!row.ruleIds.includes(id)) row.ruleIds.push(id);
        }

        // `message` belongs to the rule this event is about, which is only
        // unambiguous in the one-event-per-rule shape.
        if (named !== null && meta.message) row.ruleMessages[String(named)] = meta.message;
        if (isHubRule && !row.ruleNames.includes(ruleName)) row.ruleNames.push(ruleName);

        byHost.set(host, row);
      }

      for (const row of byHost.values()) {
        if (!row.ruleIds.length && !row.ruleNames.length) continue;
        row.ruleIds.sort((a, b) => a - b);
        rows.push(row);
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * Matches folded by source address, newest CrowdSec has first.
 *
 * Repeats are counted rather than discarded. An earlier version deduplicated
 * identical matches so the table would not fill with copies — but the number of
 * copies *is* the signal. A rule that fired ninety times against one address is
 * what is breaking that user; a rule that fired once beside it is noise, and the
 * two look identical without the count.
 *
 * @param hosts When given, only these hostnames' traffic. The application page
 *   passes every name it answers on, and passing them here rather than
 *   filtering afterwards is what keeps one team from seeing another's requests.
 */
export function groupAppsecBySource(
  rows: CrowdsecAppsecAlert[],
  hosts?: string[],
): AppsecSourceGroup[] {
  const groups = new Map<string, AppsecSourceGroup>();
  // Per group: rule id → count, message and the hosts it fired against, kept
  // aside so the public shape stays an array sorted by what matters.
  const counts = new Map<
    string,
    Map<string, { count: number; message: string; hosts: string[] }>
  >();
  const wanted = hosts?.length ? new Set(hosts) : null;

  for (const row of rows) {
    // The Host header carries the port on entryPoints other than 443 —
    // `versity.example.com:1443` — where an application's domain never does.
    const bare = row.host.split(':')[0];
    if (wanted && !wanted.has(bare)) continue;

    const ip = row.sourceIp || 'unknown';
    const group = groups.get(ip) ?? {
      sourceIp: ip,
      country: row.country,
      asName: row.asName,
      requests: 0,
      hosts: [],
      rules: [],
      paths: [],
      lastSeen: '',
    };
    const tally =
      counts.get(ip) ?? new Map<string, { count: number; message: string; hosts: string[] }>();

    group.requests += 1;
    if (row.at > group.lastSeen) group.lastSeen = row.at;
    if (!group.hosts.includes(row.host)) group.hosts.push(row.host);
    // A handful of examples, not every URL: this is evidence for a judgement,
    // and the same signed upload URL forty times over is not more evidence.
    if (row.uri && group.paths.length < 5 && !group.paths.includes(row.uri)) {
      group.paths.push(row.uri);
    }

    // Both axes, not one-or-the-other: a request can trip CRS signatures and a
    // hub rule, and counting only the first would hide the second.
    const ids: Array<number | string> = [...row.ruleIds, ...row.ruleNames];
    for (const id of ids) {
      const key = String(id);
      const existing = tally.get(key) ?? { count: 0, message: '', hosts: [] };
      existing.count += 1;
      if (!existing.message && row.ruleMessages[key]) existing.message = row.ruleMessages[key];
      // Bare, because that is what an exclusion names: the same rule firing on
      // :443 and :1443 of one application is one application, not two.
      if (!existing.hosts.includes(bare)) existing.hosts.push(bare);
      tally.set(key, existing);
    }

    counts.set(ip, tally);
    groups.set(ip, group);
  }

  for (const [ip, tally] of counts) {
    const group = groups.get(ip)!;
    group.rules = [...tally.entries()]
      .map(([key, { count, message, hosts: firedOn }]) => ({
        id: /^\d+$/.test(key) ? Number(key) : key,
        message,
        count,
        hosts: firedOn,
      }))
      // Loudest first — that is the one to look at. Ties break on the id so the
      // order is stable between polls rather than shuffling under the cursor.
      .sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)));
  }

  return [...groups.values()].sort((a, b) => b.requests - a.requests);
}

/** The CrowdSec container on this worker, or null. */
export async function findCrowdsecContainer(client: {
  listContainers: (all: boolean) => Promise<any[]>;
}): Promise<any | null> {
  const all = await client.listContainers(true);
  return (
    all.find(
      (c: any) =>
        c.Names?.includes('/crowdsec') || c.Names?.some((n: string) => n.includes('crowdsec')),
    ) ?? null
  );
}
