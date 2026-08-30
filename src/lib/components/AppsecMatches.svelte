<script lang="ts">
  /**
   * What the WAF has matched, grouped by source address.
   *
   * Shared by the application page and the worker page. The application page is
   * the one that matters: the worker page is admin-only, so the people who own
   * an application — the only ones who can say whether a match is legitimate
   * traffic — could not otherwise see any of this.
   *
   * Grouping is by address because that is the unit a ban applies to, and counts
   * are shown because the count is the signal. A rule that fired ninety times
   * against one address is what is breaking that user; the rule that fired once
   * beside it is noise, and they look identical without the number.
   */
  import { metaRuleNote } from '$lib/appsec-rules';
  import { timeAgo } from '$lib/format';

  interface Decision {
    id: number;
    value: string;
    scope: string;
    reason: string;
    type: string;
    duration: string;
    country: string;
    asName: string;
  }

  interface RuleCount {
    id: number | string;
    message: string;
    count: number;
    /** The hostnames this rule fired against, for this source. */
    hosts?: string[];
    /** ISO, or '' — when this rule last and first matched. */
    lastSeen?: string;
    firstSeen?: string;
  }
  interface SourceGroup {
    sourceIp: string;
    country: string;
    asName: string;
    requests: number;
    hosts: string[];
    rules: RuleCount[];
    paths: string[];
    /** ISO, or '' — these are historical and the age changes what they mean. */
    lastSeen?: string;
  }

  let {
    sources = [],
    /** The application's hostname, when this is one application's page. */
    host = undefined,
    /** Whether the viewer may change this application's excluded rules. */
    canExclude = false,
    onExcludeMany,
    busyBulk = null,
    /** Rules already disabled for this application, as stored. */
    disabledRules = [],
    /** Active CrowdSec bans on the worker, which apply to every application. */
    decisions = [],
    /** Bans that have already lapsed, by address. */
    banHistory = {},
    /** Lifting a ban is worker-wide, so only an admin is offered it. */
    canLiftDecisions = false,
    onLiftDecision,
    busyDecision = null,
  }: {
    sources: SourceGroup[];
    host?: string;
    canExclude?: boolean;
    /**
     * Disable the ticked rules. `source` narrows them to one address; omitted
     * means all traffic.
     *
     * The only way to disable anything from this table, including one rule —
     * a selection of one is a selection. There used to be a pair of buttons on
     * every row as well, which meant two ways to do the same thing, twenty-five
     * pairs of buttons on a real table, and no room for anything else. It also
     * made the expensive path the easy one: each write restarts CrowdSec on the
     * worker, so clicking down the rows was one restart per rule.
     */
    onExcludeMany?: (host: string, rules: string[], source?: string) => void;
    /** `host|source` while a bulk request is in flight. */
    busyBulk?: string | null;
    disabledRules?: string[];
    decisions?: Decision[];
    banHistory?: Record<string, { at: string; scenario: string; expired: boolean }>;
    canLiftDecisions?: boolean;
    onLiftDecision?: (decision: Decision) => void;
    busyDecision?: number | null;
  } = $props();

  /** The active ban on this address, if there is one. */
  function banFor(sourceIp: string): Decision | null {
    return decisions.find((d) => d.value === sourceIp) ?? null;
  }

  /**
   * Bans on addresses this application has no match for.
   *
   * A decision is worker-wide, so an address banned while probing some other
   * application cannot reach this one either — and with nothing attributed to
   * it here, that user would otherwise be invisible. This is the difference
   * between "what the WAF noticed about us" and "who is actually being turned
   * away", and the second is the question an owner is usually asking.
   */
  const unmatchedBans = $derived(
    decisions.filter((d) => !sources.some((s) => s.sourceIp === d.value)),
  );

  /**
   * Whether this rule is already off for this group, and at which scope.
   *
   * Two independent exclusions can exist for one rule — everywhere, and for one
   * address — so the row has to say which of the two is in force rather than
   * collapsing them into "disabled" and leaving the other button looking
   * available when it is not.
   */
  function disabledScope(rule: RuleCount, sourceIp: string): 'all' | 'source' | null {
    const id = String(rule.id);
    if (disabledRules.includes(id)) return 'all';
    if (disabledRules.includes(`${id}@${sourceIp}`)) return 'source';
    // A range that covers this address is stored as its own entry; without
    // parsing CIDR in the browser, an exact match is all this can claim.
    return null;
  }

  /**
   * How old a rule's matches are, and over what span.
   *
   * The age is the thing that decides whether a rule is worth acting on. These
   * alerts are history — a source group routinely covers a day — so a rule that
   * fired ninety times an hour ago and one that fired ninety times last Tuesday
   * are indistinguishable without it, and only the first is breaking anything
   * now. The span goes in the title because a burst and a steady trickle mean
   * different things and both read as one number.
   */
  function ageTitle(rule: RuleCount): string {
    if (!rule.lastSeen) return '';
    if (!rule.firstSeen || rule.firstSeen === rule.lastSeen) return rule.lastSeen;
    return `First ${rule.firstSeen}\nLast ${rule.lastSeen}`;
  }

  /**
   * The hostnames an exclusion for this rule could apply to.
   *
   * Per rule, not per group. One source commonly hits several applications — a
   * real group covered versity on three ports, projectsend, uptime-kuma and
   * seatsurfing — so asking the question at the group level left every button
   * hidden, which is how this shipped with nothing actionable on it at all.
   *
   * On an application's own page there is exactly one answer, so exactly one
   * button.
   */
  function targets(rule: RuleCount): string[] {
    if (host) return [host];
    const seen: string[] = [];
    for (const h of rule.hosts ?? []) {
      const bare = h.split(':')[0];
      if (bare && !seen.includes(bare)) seen.push(bare);
    }
    return seen;
  }

  /**
   * Ticked rules, keyed `address|rule`.
   *
   * Keyed by address as well as rule because the same rule appears under every
   * source that tripped it, and those are separate decisions: excluding 942100
   * for the office address says nothing about excluding it for a scanner.
   *
   * Never read directly — `chosen` filters it against what is still selectable,
   * so a rule that was disabled between ticking it and clicking cannot be sent
   * twice, and a stale tick left behind by a refresh cannot resurrect itself.
   */
  let selected = $state<Record<string, boolean>>({});

  function key(sourceIp: string, rule: RuleCount): string {
    return `${sourceIp}|${rule.id}`;
  }

  /** Whether this row is a rule somebody could actually switch off. */
  function selectable(rule: RuleCount, sourceIp: string): boolean {
    return (
      canExclude &&
      !!onExcludeMany &&
      !metaRuleNote(rule.id) &&
      disabledScope(rule, sourceIp) === null
    );
  }

  /** The rules ticked for this address that are still worth sending. */
  function chosen(group: SourceGroup): RuleCount[] {
    return group.rules.filter(
      (rule) => selected[key(group.sourceIp, rule)] && selectable(rule, group.sourceIp),
    );
  }

  function selectableRules(group: SourceGroup): RuleCount[] {
    return group.rules.filter((rule) => selectable(rule, group.sourceIp));
  }

  function setAll(group: SourceGroup, on: boolean): void {
    for (const rule of selectableRules(group)) selected[key(group.sourceIp, rule)] = on;
  }

  function clear(group: SourceGroup): void {
    for (const rule of group.rules) delete selected[key(group.sourceIp, rule)];
  }

  /**
   * The hostnames a bulk exclusion would be written against, and what to send
   * to each.
   *
   * Per host rather than one list for all of them: on the worker page a source
   * commonly hits several applications, and sending every ticked rule to every
   * host would disable rules on applications they never fired against. Each
   * host gets only the rules that actually matched it.
   */
  function bulkGroups(group: SourceGroup): Array<{ target: string; rules: RuleCount[] }> {
    const byTarget = new Map<string, RuleCount[]>();
    for (const rule of chosen(group)) {
      for (const target of targets(rule)) {
        byTarget.set(target, [...(byTarget.get(target) ?? []), rule]);
      }
    }
    return [...byTarget.entries()].map(([target, rules]) => ({ target, rules }));
  }
</script>

{#if sources.length === 0 && unmatchedBans.length === 0}
  <p class="empty">Nothing has been matched by the firewall.</p>
{:else}
  {#each sources as group}
    {@const ban = banFor(group.sourceIp)}
    {@const pickable = selectableRules(group)}
    {@const picked = chosen(group)}
    <div class="source" class:is-banned={ban}>
      <div class="source-head">
        <span class="mono addr">{group.sourceIp}</span>
        {#if group.country || group.asName}
          <span class="origin">{[group.country, group.asName].filter(Boolean).join(' · ')}</span>
        {/if}
        {#if group.lastSeen}
          <span class="origin" title={group.lastSeen}>last seen {timeAgo(group.lastSeen)}</span>
        {/if}
        {#if ban}
          <!-- The thing an owner actually came to find out. Matches say what the
               WAF noticed; this says the user is being turned away right now. -->
          <span class="ban-badge" title={`${ban.type} — ${ban.reason || 'CrowdSec'}`}>
            blocked{ban.duration ? ` · ${ban.duration}` : ''}
          </span>
          {#if canLiftDecisions && onLiftDecision}
            <button
              class="btn-disable btn-disable--scoped"
              disabled={busyDecision === ban.id}
              onclick={() => onLiftDecision(ban)}
              title={`Lift the ban on ${group.sourceIp} across this whole worker`}
            >{busyDecision === ban.id ? 'Lifting…' : 'Unblock'}</button>
          {/if}
        {:else if banHistory[group.sourceIp]?.expired}
          <!-- Why an obvious attacker can show no ban: CrowdSec banned it and
               the ban ran out. Without this the row reads as "the WAF did
               nothing", which is the opposite of what happened. -->
          <span class="ban-badge ban-badge--past" title={banHistory[group.sourceIp].scenario}>
            was blocked · expired
          </span>
        {/if}
        <span class="requests">{group.requests} request{group.requests === 1 ? '' : 's'}</span>
      </div>

      {#if ban}
        <p class="ban-note">
          Blocked from <strong>every application on this worker</strong> — a ban is by address,
          not by application. Reason: <span class="mono">{ban.reason || 'unknown'}</span>.
          {#if !canLiftDecisions}
            Lifting it needs an administrator.
          {/if}
        </p>
      {:else if banHistory[group.sourceIp]?.expired}
        <p class="ban-note ban-note--past">
          CrowdSec banned this address {timeAgo(banHistory[group.sourceIp].at)}
          (<span class="mono">{banHistory[group.sourceIp].scenario || 'unknown'}</span>) and
          <strong>that ban has since expired</strong>. Bans are time-limited and are re-applied
          when the behaviour repeats, so a source can show a large number of matches here and no
          block right now.
        </p>
      {/if}

      {#if !host && group.hosts.length}
        <div class="hosts">
          {#each group.hosts as h}<span class="mono host">{h}</span>{/each}
        </div>
      {/if}

      <table class="rules">
        <thead>
          <tr>
            {#if pickable.length > 0}
              <th class="pick">
                <!-- Select-all covers only the rules that can be switched off.
                     The meta rules and the already-disabled ones are in the
                     table for context, and a tick that silently skipped them
                     would report a count nobody could reconcile. -->
                <input
                  type="checkbox"
                  aria-label={`Select every disableable rule for ${group.sourceIp}`}
                  checked={picked.length === pickable.length}
                  indeterminate={picked.length > 0 && picked.length < pickable.length}
                  onchange={(e) => setAll(group, e.currentTarget.checked)}
                />
              </th>
            {/if}
            <th>Rule</th><th>What it matched</th><th class="num">Fired</th>
            <th class="when">Last seen</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each group.rules as rule}
            {@const note = metaRuleNote(rule.id)}
            {@const scope = disabledScope(rule, group.sourceIp)}
            <tr class:is-meta={note} class:is-off={scope}>
              {#if pickable.length > 0}
                <td class="pick">
                  {#if selectable(rule, group.sourceIp)}
                    <input
                      type="checkbox"
                      aria-label={`Select rule ${rule.id}`}
                      checked={!!selected[key(group.sourceIp, rule)]}
                      onchange={(e) =>
                        (selected[key(group.sourceIp, rule)] = e.currentTarget.checked)}
                    />
                  {/if}
                </td>
              {/if}
              <td><span class="mono rule-id">{rule.id}</span></td>
              <td>
                {rule.message || (note ? '' : '—')}
                {#if note}<span class="note">{note}</span>{/if}
                {#if scope}
                  <!-- Alerts are historical: a rule disabled a minute ago is
                       still in everything recorded before that. Without saying
                       so, offering to disable it again reads as the click
                       having failed. -->
                  <span class="note">
                    already disabled {scope === 'all'
                      ? 'for all traffic'
                      : `for ${group.sourceIp}`} — older matches still listed
                  </span>
                {/if}
              </td>
              <td class="num"><strong>{rule.count}</strong></td>
              <td class="when" title={ageTitle(rule)}>
                {rule.lastSeen ? timeAgo(rule.lastSeen) : '—'}
              </td>
              <td class="action">
                {#if scope}
                  <span class="cannot">{scope === 'all' ? 'disabled' : 'disabled for this IP'}</span>
                {:else if note}
                  <!-- Why this row has no checkbox. Excluding the anomaly gate
                       switches CRS off for the application rather than narrowing
                       it, and the setup and reporting rules stop nothing. -->
                  <span class="cannot">cannot be disabled</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if picked.length > 0 && onExcludeMany}
        <div class="bulk">
          <span class="bulk-count">
            {picked.length} rule{picked.length === 1 ? '' : 's'} selected
          </span>
          {#each bulkGroups(group) as { target, rules }}
            {@const label = host ? '' : `${target.split('.')[0]}: `}
            {@const ids = rules.map((r) => String(r.id))}
            <button
              class="btn-disable"
              disabled={busyBulk === `${target}|`}
              onclick={() => onExcludeMany(target, ids)}
              title={`Stop these ${ids.length} rules firing for ${target}, whoever sends the request`}
            >{busyBulk === `${target}|` ? 'Disabling…' : `${label}all traffic`}</button>
            <button
              class="btn-disable btn-disable--scoped"
              disabled={busyBulk === `${target}|${group.sourceIp}`}
              onclick={() => onExcludeMany(target, ids, group.sourceIp)}
              title={`Stop these ${ids.length} rules firing for ${target}, but only for requests from ${group.sourceIp}`}
            >{busyBulk === `${target}|${group.sourceIp}` ? 'Disabling…' : `${label}this IP`}</button>
          {/each}
          <button class="bulk-clear" onclick={() => clear(group)}>Clear</button>
        </div>
      {/if}

      {#if group.paths.length}
        <details class="paths">
          <summary>Paths it requested ({group.paths.length})</summary>
          <ul>
            {#each group.paths as p}<li><span class="mono">{p}</span></li>{/each}
          </ul>
        </details>
      {/if}
    </div>
  {/each}

  {#if unmatchedBans.length > 0}
    <div class="source is-banned">
      <div class="source-head">
        <span class="addr">Blocked, with nothing matched here</span>
        <span class="requests">{unmatchedBans.length}</span>
      </div>
      <p class="ban-note">
        These addresses cannot reach this application either — a ban is by address and applies
        across the worker — but what triggered them happened somewhere else, so there is nothing
        here to disable. Lifting one is the only remedy.
      </p>
      <table class="rules">
        <thead><tr><th>Address</th><th>Reason</th><th class="num">Expires in</th><th></th></tr></thead>
        <tbody>
          {#each unmatchedBans as ban}
            <tr>
              <td>
                <span class="mono rule-id">{ban.value}</span>
                {#if ban.country || ban.asName}
                  <span class="note">{[ban.country, ban.asName].filter(Boolean).join(' · ')}</span>
                {/if}
              </td>
              <td>{ban.reason || '—'}</td>
              <td class="num">{ban.duration || '—'}</td>
              <td class="action">
                {#if canLiftDecisions && onLiftDecision}
                  <button
                    class="btn-disable btn-disable--scoped"
                    disabled={busyDecision === ban.id}
                    onclick={() => onLiftDecision(ban)}
                    title={`Lift the ban on ${ban.value} across this whole worker`}
                  >{busyDecision === ban.id ? 'Lifting…' : 'Unblock'}</button>
                {:else}
                  <span class="cannot">needs an admin</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  .source {
    border: 1px solid var(--border-default);
    border-radius: 6px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  .source-head {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    padding: 8px 12px;
    background: var(--bg-overlay);
    border-bottom: 1px solid var(--border-subtle);
  }
  .addr { font-size: 13px; color: var(--text-primary); font-weight: 600; }
  /* A blocked source is the one thing on this page that is happening *now*, so
     it gets the only strong colour. Red, not amber: amber already means "this
     rule is machinery you cannot disable", and the two must not be confused. */
  .is-banned { border-color: color-mix(in srgb, var(--red, #f85149) 35%, var(--border-default)); }
  .ban-badge {
    padding: 1px 7px; border-radius: 3px; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--red-text, #f85149);
    background: color-mix(in srgb, var(--red, #f85149) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--red, #f85149) 35%, transparent);
  }
  .ban-note {
    margin: 0; padding: 8px 12px; font-size: 11px; line-height: 1.5;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--red, #f85149) 7%, transparent);
    border-bottom: 1px solid var(--border-subtle);
  }
  /* A lapsed ban is history, not an alarm — it reads muted so a live block
     stays the only thing on the page shouting. */
  .ban-badge--past {
    color: var(--text-muted);
    background: var(--bg-overlay);
    border-color: var(--border-default);
  }
  .ban-note--past { background: var(--bg-overlay); }
  .origin { font-size: 11px; color: var(--text-muted); }
  .requests { margin-left: auto; font-size: 11px; color: var(--text-muted); }
  .hosts { padding: 6px 12px 0; display: flex; gap: 6px; flex-wrap: wrap; }
  .host {
    font-size: 10px; color: var(--text-secondary);
    background: var(--bg-overlay); border-radius: 3px; padding: 1px 5px;
  }
  .rules { width: 100%; border-collapse: collapse; }
  .rules th {
    text-align: left; padding: 6px 12px; font-size: 10px; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
  }
  .rules td {
    padding: 6px 12px; border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary); font-size: 12px; vertical-align: top;
  }
  .pick { width: 28px; padding-right: 0; }
  .pick input { cursor: pointer; margin: 0; }
  /* Sits directly under the table it acts on, so the count and the buttons read
     as one sentence about the rows above rather than a floating toolbar. */
  .bulk {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 8px 12px;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-overlay);
  }
  .bulk-count { font-size: 11px; color: var(--text-primary); font-weight: 600; margin-right: auto; }
  .bulk-clear {
    padding: 3px 8px; font-size: 11px; font-family: inherit;
    border: none; background: none; color: var(--text-muted); cursor: pointer;
  }
  .bulk-clear:hover { color: var(--text-secondary); text-decoration: underline; }
  .num { text-align: right; width: 60px; }
  /* Right-aligned against the count, so the pair reads as "how much, how
     recently" rather than as two unrelated columns. */
  .when { width: 110px; text-align: right; font-size: 11px; color: var(--text-muted); }
  /* The count is the point of the table, so it reads before the prose. */
  .num strong { font-size: 14px; color: var(--text-primary); }
  .rule-id { font-size: 12px; }
  /* Only ever holds a short status now that the per-row buttons are gone — the
     action moved to the bar under the table, where it is taken once for a
     selection rather than once per row. */
  .action { width: 130px; text-align: right; }

  /* Styled here rather than borrowing the host page's `btn-tiny`. Svelte scopes
     styles to the component that declares them, so a class defined in the page
     never reaches this markup — the buttons rendered as raw browser controls on
     both pages, and the application page does not define `btn-tiny` at all. */
  .btn-disable {
    padding: 3px 10px;
    margin-left: 4px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    border: 1px solid var(--border-default);
    background: var(--bg-raised);
    color: var(--text-secondary);
    transition: all 0.15s;
  }
  /* Amber on hover, not red. Disabling a rule gives up protection, so it should
     not read as the neutral action — but it is reversible, and red belongs to
     the things that are not. */
  .btn-disable:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--warning, #d29922);
    border-color: color-mix(in srgb, var(--warning, #d29922) 40%, transparent);
  }
  .btn-disable:disabled { opacity: 0.4; cursor: not-allowed; }
  /* The narrower of the two reads as the lighter action, because it is: it
     keeps the rule protecting the application against every other source. */
  .btn-disable--scoped { background: transparent; }
  .btn-disable--scoped:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-strong, var(--text-muted));
  }
  .btn-disable + .btn-disable { margin-left: 4px; }
  .is-meta .rule-id { color: var(--warning, #d29922); }
  /* Already off. Kept visible rather than filtered out, so a rule that is still
     matching after being disabled is something you can actually notice. */
  .is-off { opacity: 0.55; }
  .is-off .rule-id { text-decoration: line-through; }
  .note { display: block; font-size: 10px; color: var(--text-muted); margin-top: 2px; }
  .cannot { font-size: 10px; color: var(--text-muted); }
  .paths { padding: 6px 12px 10px; }
  .paths summary { font-size: 11px; color: var(--text-muted); cursor: pointer; }
  .paths ul { margin: 6px 0 0; padding-left: 16px; }
  .paths li { font-size: 11px; color: var(--text-secondary); word-break: break-all; }
  .empty { color: var(--text-muted); font-size: 12px; }
</style>
