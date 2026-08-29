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

  interface RuleCount {
    id: number | string;
    message: string;
    count: number;
    /** The hostnames this rule fired against, for this source. */
    hosts?: string[];
  }
  interface SourceGroup {
    sourceIp: string;
    country: string;
    asName: string;
    requests: number;
    hosts: string[];
    rules: RuleCount[];
    paths: string[];
  }

  let {
    sources = [],
    /** The application's hostname, when this is one application's page. */
    host = undefined,
    /** Whether the viewer may change this application's excluded rules. */
    canExclude = false,
    onExclude,
    busyRule = null,
    /** Rules already disabled for this application, as strings. */
    disabledRules = [],
  }: {
    sources: SourceGroup[];
    host?: string;
    canExclude?: boolean;
    onExclude?: (host: string, rule: string) => void;
    busyRule?: string | null;
    disabledRules?: string[];
  } = $props();

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
</script>

{#if sources.length === 0}
  <p class="empty">Nothing has been matched by the firewall.</p>
{:else}
  {#each sources as group}
    <div class="source">
      <div class="source-head">
        <span class="mono addr">{group.sourceIp}</span>
        {#if group.country || group.asName}
          <span class="origin">{[group.country, group.asName].filter(Boolean).join(' · ')}</span>
        {/if}
        <span class="requests">{group.requests} request{group.requests === 1 ? '' : 's'}</span>
      </div>

      {#if !host && group.hosts.length}
        <div class="hosts">
          {#each group.hosts as h}<span class="mono host">{h}</span>{/each}
        </div>
      {/if}

      <table class="rules">
        <thead><tr><th>Rule</th><th>What it matched</th><th class="num">Fired</th><th></th></tr></thead>
        <tbody>
          {#each group.rules as rule}
            {@const note = metaRuleNote(rule.id)}
            {@const hostsFor = targets(rule)}
            {@const off = disabledRules.includes(String(rule.id))}
            <tr class:is-meta={note} class:is-off={off}>
              <td><span class="mono rule-id">{rule.id}</span></td>
              <td>
                {rule.message || (note ? '' : '—')}
                {#if note}<span class="note">{note}</span>{/if}
                {#if off}
                  <!-- Alerts are historical: a rule disabled a minute ago is
                       still in everything recorded before that. Without saying
                       so, offering "Disable" again reads as the click having
                       failed. -->
                  <span class="note">already disabled — older matches still listed</span>
                {/if}
              </td>
              <td class="num"><strong>{rule.count}</strong></td>
              <td class="action">
                {#if off}
                  <span class="cannot">disabled</span>
                {:else if note}
                  <!-- Not offered. Excluding the anomaly gate switches CRS off
                       for the application rather than narrowing it, and the
                       setup and reporting rules stop nothing. -->
                  <span class="cannot">cannot be disabled</span>
                {:else if canExclude && onExclude}
                  {#each hostsFor as target}
                    <button
                      class="btn-tiny"
                      disabled={busyRule === `${target}|${rule.id}`}
                      onclick={() => onExclude(target, String(rule.id))}
                      title={`Stop rule ${rule.id} firing for ${target}`}
                    >{busyRule === `${target}|${rule.id}`
                      ? 'Disabling…'
                      : hostsFor.length > 1
                        ? target.split('.')[0]
                        : 'Disable'}</button>
                  {/each}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

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
  .num { text-align: right; width: 60px; }
  /* The count is the point of the table, so it reads before the prose. */
  .num strong { font-size: 14px; color: var(--text-primary); }
  .rule-id { font-size: 12px; }
  /* Wider than one button needs: on the worker page a rule that fired against
     several applications gets one button each, labelled by application. */
  .action { width: 190px; text-align: right; }
  .action :global(button) { margin-left: 4px; }
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
