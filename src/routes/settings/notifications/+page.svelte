<script lang="ts">
  import AppLayout from '$lib/components/AppLayout.svelte';
  import { page } from '$app/stores';

  let { data } = $props();

  // ── Notification Channels ─────────────────────────────────────────────
  let channels = $state<any[]>([]);
  let showChannelForm = $state(false);
  let editingChannelId = $state<string | null>(null);
  let channelName = $state('');
  let channelType = $state<'webhook' | 'slack' | 'email'>('webhook');
  let channelUrl = $state('');
  let channelSaving = $state(false);

  function resetChannelForm() {
    channelName = '';
    channelType = 'webhook';
    channelUrl = '';
    editingChannelId = null;
    showChannelForm = false;
  }

  function editChannel(ch: any) {
    editingChannelId = ch.id;
    channelName = ch.name;
    channelType = ch.type;
    try {
      const cfg = JSON.parse(ch.config);
      channelUrl = cfg.url || cfg.webhookUrl || '';
    } catch {
      channelUrl = '';
    }
    showChannelForm = true;
  }

  function getChannelConfig(): string {
    if (channelType === 'webhook') return JSON.stringify({ url: channelUrl });
    if (channelType === 'slack') return JSON.stringify({ webhookUrl: channelUrl });
    if (channelType === 'email') return JSON.stringify({ to: channelUrl });
    return '{}';
  }

  async function saveChannel() {
    channelSaving = true;
    try {
      if (editingChannelId) {
        const res = await fetch(`/api/notifications/${editingChannelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: channelName,
            type: channelType,
            config: getChannelConfig(),
          }),
        });
        if (res.ok) {
          channels = channels.map(ch =>
            ch.id === editingChannelId
              ? { ...ch, name: channelName, type: channelType, config: getChannelConfig(), updatedAt: new Date().toISOString() }
              : ch
          );
          resetChannelForm();
        }
      } else {
        const res = await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: channelName,
            type: channelType,
            config: getChannelConfig(),
          }),
        });
        if (res.ok) {
          const result = await res.json();
          channels = [...channels, {
            id: result.id,
            name: channelName,
            type: channelType,
            config: getChannelConfig(),
            enabled: true,
            teamId: null,
            createdBy: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }];
          resetChannelForm();
        }
      }
    } catch (e) {
      console.error('Failed to save channel:', e);
    } finally {
      channelSaving = false;
    }
  }

  async function deleteChannel(id: string) {
    if (!confirm('Delete this notification channel?')) return;
    const res = await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    if (res.ok) {
      channels = channels.filter(ch => ch.id !== id);
    }
  }

  async function toggleChannel(ch: any) {
    const newEnabled = !ch.enabled;
    const res = await fetch(`/api/notifications/${ch.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    if (res.ok) {
      channels = channels.map(c => c.id === ch.id ? { ...c, enabled: newEnabled } : c);
    }
  }

  // ── Alert Rules ───────────────────────────────────────────────────────
  let rules = $state<any[]>([]);
  let showRuleForm = $state(false);
  let editingRuleId = $state<string | null>(null);
  let ruleName = $state('');
  let ruleResourceType = $state<'worker' | 'container' | 'application'>('worker');
  let ruleResourceId = $state('');
  let ruleMetric = $state('cpu_percent');
  let ruleOperator = $state<'gt' | 'lt' | 'gte' | 'lte' | 'eq'>('gt');
  let ruleThreshold = $state(80);
  let ruleDuration = $state<number | undefined>(undefined);
  let ruleChannelId = $state('');
  let ruleSaving = $state(false);

  const workerMetricOptions = ['cpu_percent', 'mem_percent', 'disk_percent', 'mem_usage_bytes', 'disk_usage_bytes', 'containers_running'];
  const containerMetricOptions = ['cpu_percent', 'mem_percent', 'mem_usage_bytes', 'net_rx_bytes', 'net_tx_bytes'];

  let availableMetrics = $derived(
    ruleResourceType === 'worker' ? workerMetricOptions :
    ruleResourceType === 'container' ? containerMetricOptions :
    containerMetricOptions
  );

  function resetRuleForm() {
    ruleName = '';
    ruleResourceType = 'worker';
    ruleResourceId = '';
    ruleMetric = 'cpu_percent';
    ruleOperator = 'gt';
    ruleThreshold = 80;
    ruleDuration = undefined;
    ruleChannelId = '';
    editingRuleId = null;
    showRuleForm = false;
  }

  function editRule(r: any) {
    editingRuleId = r.id;
    ruleName = r.name;
    ruleResourceType = r.resourceType;
    ruleResourceId = r.resourceId || '';
    ruleMetric = r.metric;
    ruleOperator = r.operator;
    ruleThreshold = r.threshold;
    ruleDuration = r.duration || undefined;
    ruleChannelId = r.channelId || '';
    showRuleForm = true;
  }

  async function saveRule() {
    ruleSaving = true;
    try {
      if (editingRuleId) {
        const res = await fetch(`/api/alerts/${editingRuleId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: ruleName,
            resourceType: ruleResourceType,
            resourceId: ruleResourceId || null,
            metric: ruleMetric,
            operator: ruleOperator,
            threshold: ruleThreshold,
            duration: ruleDuration || null,
            channelId: ruleChannelId || null,
          }),
        });
        if (res.ok) {
          rules = rules.map(r =>
            r.id === editingRuleId
              ? { ...r, name: ruleName, resourceType: ruleResourceType, resourceId: ruleResourceId || null, metric: ruleMetric, operator: ruleOperator, threshold: ruleThreshold, duration: ruleDuration || null, channelId: ruleChannelId || null, updatedAt: new Date().toISOString() }
              : r
          );
          resetRuleForm();
        }
      } else {
        const res = await fetch('/api/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: ruleName,
            resourceType: ruleResourceType,
            resourceId: ruleResourceId || null,
            metric: ruleMetric,
            operator: ruleOperator,
            threshold: ruleThreshold,
            duration: ruleDuration || null,
            channelId: ruleChannelId || null,
          }),
        });
        if (res.ok) {
          const result = await res.json();
          rules = [...rules, {
            id: result.id,
            name: ruleName,
            resourceType: ruleResourceType,
            resourceId: ruleResourceId || null,
            metric: ruleMetric,
            operator: ruleOperator,
            threshold: ruleThreshold,
            duration: ruleDuration || null,
            channelId: ruleChannelId || null,
            enabled: true,
            teamId: null,
            lastTriggeredAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }];
          resetRuleForm();
        }
      }
    } catch (e) {
      console.error('Failed to save rule:', e);
    } finally {
      ruleSaving = false;
    }
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete this alert rule?')) return;
    const res = await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
    if (res.ok) {
      rules = rules.filter(r => r.id !== id);
    }
  }

  async function toggleRule(r: any) {
    const newEnabled = !r.enabled;
    const res = await fetch(`/api/alerts/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    if (res.ok) {
      rules = rules.map(rule => rule.id === r.id ? { ...rule, enabled: newEnabled } : rule);
    }
  }

  // ── Alert Events ──────────────────────────────────────────────────────
  let events = $state<any[]>([]);

  $effect(() => {
    channels = data.channels ?? [];
    rules = data.rules ?? [];
    events = data.events ?? [];
  });

  async function acknowledgeEvent(id: string) {
    const res = await fetch('/api/alerts/events', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acknowledged: true }),
    });
    if (res.ok) {
      events = events.map(ev => ev.id === id ? { ...ev, acknowledged: true } : ev);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function getChannelName(channelId: string | null): string {
    if (!channelId) return '—';
    const ch = channels.find(c => c.id === channelId);
    return ch ? ch.name : channelId.slice(0, 8);
  }

  function formatOperator(op: string): string {
    const map: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=' };
    return map[op] || op;
  }

  function formatDate(iso: string): string {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function getSeverityFromValue(value: number, threshold: number): string {
    if (threshold === 0) return 'critical';
    const ratio = Math.abs(value / threshold);
    if (ratio >= 1.5) return 'critical';
    if (ratio >= 1.2) return 'warning';
    return 'info';
  }

  const urlLabel = $derived(channelType === 'slack' ? 'Slack Webhook URL' : channelType === 'email' ? 'Recipient Email' : 'Webhook URL');
  const urlPlaceholder = $derived(channelType === 'slack' ? 'https://hooks.slack.com/services/...' : channelType === 'email' ? 'alerts@example.com' : 'https://example.com/webhook');
</script>

<AppLayout user={data.user} activePage="notifications" pathname={$page.url.pathname}>

<header>
  <h1>Notifications & Alerts</h1>
  <p class="subtitle">Manage notification channels, alert rules, and view alert history</p>
</header>

<!-- ── Notification Channels ────────────────────────────────────────── -->
<section class="section">
  <div class="section-header">
    <h2>Notification Channels</h2>
    <button class="btn-primary btn-sm" onclick={() => { resetChannelForm(); showChannelForm = true; }}>
      + Add Channel
    </button>
  </div>

  {#if showChannelForm}
    <div class="inline-form">
      <h3>{editingChannelId ? 'Edit Channel' : 'New Channel'}</h3>
      <div class="form-row">
        <div class="form-group">
          <label for="ch-name">Name</label>
          <input type="text" id="ch-name" bind:value={channelName} placeholder="e.g. Production Alerts" />
        </div>
        <div class="form-group">
          <label for="ch-type">Type</label>
          <select id="ch-type" bind:value={channelType}>
            <option value="webhook">Webhook</option>
            <option value="slack">Slack</option>
            <option value="email">Email</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label for="ch-url">{urlLabel}</label>
        <input type="text" id="ch-url" bind:value={channelUrl} placeholder={urlPlaceholder} />
      </div>
      <div class="form-actions-inline">
        <button class="btn-primary btn-sm" onclick={saveChannel} disabled={channelSaving || !channelName || !channelUrl}>
          {channelSaving ? 'Saving...' : editingChannelId ? 'Update' : 'Create'}
        </button>
        <button class="btn-ghost btn-sm" onclick={resetChannelForm}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if channels.length === 0}
    <div class="empty-state">No notification channels configured yet.</div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Enabled</th>
            <th>Created</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each channels as ch (ch.id)}
            <tr>
              <td class="cell-name">{ch.name}</td>
              <td>
                <span class="badge badge-{ch.type}">{ch.type}</span>
              </td>
              <td>
                <label class="toggle-sm">
                  <input type="checkbox" checked={ch.enabled} onchange={() => toggleChannel(ch)} />
                  <span class="slider-sm"></span>
                </label>
              </td>
              <td class="cell-date">{formatDate(ch.createdAt)}</td>
              <td class="actions-col">
                <button class="btn-icon" title="Edit" onclick={() => editChannel(ch)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 1.5l2 2-7 7H3.5v-2l7-7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                </button>
                <button class="btn-icon btn-danger" title="Delete" onclick={() => deleteChannel(ch.id)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M6 6.5v3M8 6.5v3M4 4l.5 7a1 1 0 001 1h3a1 1 0 001-1L10 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<!-- ── Alert Rules ──────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-header">
    <h2>Alert Rules</h2>
    <button class="btn-primary btn-sm" onclick={() => { resetRuleForm(); showRuleForm = true; }}>
      + Add Rule
    </button>
  </div>

  {#if showRuleForm}
    <div class="inline-form">
      <h3>{editingRuleId ? 'Edit Rule' : 'New Rule'}</h3>
      <div class="form-row">
        <div class="form-group">
          <label for="rule-name">Name</label>
          <input type="text" id="rule-name" bind:value={ruleName} placeholder="e.g. High CPU Alert" />
        </div>
        <div class="form-group">
          <label for="rule-resource-type">Resource Type</label>
          <select id="rule-resource-type" bind:value={ruleResourceType}>
            <option value="worker">Worker</option>
            <option value="container">Container</option>
            <option value="application">Application</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="rule-resource-id">Resource ID <span class="optional">(optional — blank = all)</span></label>
          <input type="text" id="rule-resource-id" bind:value={ruleResourceId} placeholder="Leave blank for all" />
        </div>
        <div class="form-group">
          <label for="rule-metric">Metric</label>
          <select id="rule-metric" bind:value={ruleMetric}>
            {#each availableMetrics as m}
              <option value={m}>{m.replace(/_/g, ' ')}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="form-row form-row-3">
        <div class="form-group">
          <label for="rule-operator">Operator</label>
          <select id="rule-operator" bind:value={ruleOperator}>
            <option value="gt">&gt; (greater than)</option>
            <option value="gte">&ge; (greater or equal)</option>
            <option value="lt">&lt; (less than)</option>
            <option value="lte">&le; (less or equal)</option>
            <option value="eq">= (equals)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="rule-threshold">Threshold</label>
          <input type="number" id="rule-threshold" bind:value={ruleThreshold} step="0.1" />
        </div>
        <div class="form-group">
          <label for="rule-duration">Duration (seconds) <span class="optional">optional</span></label>
          <input type="number" id="rule-duration" bind:value={ruleDuration} placeholder="e.g. 300" />
        </div>
      </div>
      <div class="form-group">
        <label for="rule-channel">Notification Channel</label>
        <select id="rule-channel" bind:value={ruleChannelId}>
          <option value="">— None —</option>
          {#each channels as ch}
            <option value={ch.id}>{ch.name} ({ch.type})</option>
          {/each}
        </select>
      </div>
      <div class="form-actions-inline">
        <button class="btn-primary btn-sm" onclick={saveRule} disabled={ruleSaving || !ruleName || !ruleMetric}>
          {ruleSaving ? 'Saving...' : editingRuleId ? 'Update' : 'Create'}
        </button>
        <button class="btn-ghost btn-sm" onclick={resetRuleForm}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if rules.length === 0}
    <div class="empty-state">No alert rules defined yet.</div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Resource</th>
            <th>Metric</th>
            <th>Condition</th>
            <th>Channel</th>
            <th>Enabled</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each rules as r (r.id)}
            <tr>
              <td class="cell-name">{r.name}</td>
              <td>
                <span class="badge badge-resource">{r.resourceType}</span>
                {#if r.resourceId}
                  <span class="resource-id">{r.resourceId.slice(0, 8)}</span>
                {/if}
              </td>
              <td><code class="metric-name">{r.metric.replace(/_/g, ' ')}</code></td>
              <td><code>{formatOperator(r.operator)} {r.threshold}</code></td>
              <td class="cell-channel">{getChannelName(r.channelId)}</td>
              <td>
                <label class="toggle-sm">
                  <input type="checkbox" checked={r.enabled} onchange={() => toggleRule(r)} />
                  <span class="slider-sm"></span>
                </label>
              </td>
              <td class="actions-col">
                <button class="btn-icon" title="Edit" onclick={() => editRule(r)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 1.5l2 2-7 7H3.5v-2l7-7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                </button>
                <button class="btn-icon btn-danger" title="Delete" onclick={() => deleteRule(r.id)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M6 6.5v3M8 6.5v3M4 4l.5 7a1 1 0 001 1h3a1 1 0 001-1L10 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<!-- ── Alert History ────────────────────────────────────────────────── -->
<section class="section">
  <div class="section-header">
    <h2>Alert History</h2>
    <span class="event-count">{events.length} recent events</span>
  </div>

  {#if events.length === 0}
    <div class="empty-state">No alert events recorded yet.</div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Severity</th>
            <th>Message</th>
            <th>Value</th>
            <th>Status</th>
            <th class="actions-col">Action</th>
          </tr>
        </thead>
        <tbody>
          {#each events as ev (ev.id)}
            {@const severity = getSeverityFromValue(ev.value, ev.threshold)}
            <tr class:acknowledged={ev.acknowledged}>
              <td class="cell-date">{formatDate(ev.createdAt)}</td>
              <td>
                <span class="badge severity-{severity}">{severity}</span>
              </td>
              <td class="cell-message">{ev.message}</td>
              <td><code>{ev.value}</code></td>
              <td>
                {#if ev.acknowledged}
                  <span class="badge badge-ack">Acknowledged</span>
                {:else}
                  <span class="badge badge-unack">Unacknowledged</span>
                {/if}
              </td>
              <td class="actions-col">
                {#if !ev.acknowledged}
                  <button class="btn-sm btn-ghost" onclick={() => acknowledgeEvent(ev.id)}>
                    Acknowledge
                  </button>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

</AppLayout>

<style>
  header { margin-bottom: 28px; }
  header h1 { font-size: 26px; color: var(--text-primary); margin: 0 0 6px; }
  .subtitle { color: var(--text-secondary); font-size: 14px; margin: 0; }

  .section {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin-bottom: 24px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .section-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .event-count {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ── Buttons ─────────────────────────────────────────────────── */
  .btn-primary {
    padding: 8px 16px;
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-sm { padding: 6px 12px; font-size: 12px; }

  .btn-ghost {
    padding: 6px 12px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }

  .btn-icon {
    background: transparent;
    border: 1px solid var(--border-default);
    color: var(--text-muted);
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.12s;
  }
  .btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border-focus); }
  .btn-icon.btn-danger:hover { background: var(--red-subtle); color: var(--red-text); border-color: var(--red); }

  /* ── Table ───────────────────────────────────────────────────── */
  .table-wrap { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th {
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
  }

  td {
    padding: 10px 12px;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }

  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--bg-hover); }
  tr.acknowledged { opacity: 0.6; }

  .cell-name { font-weight: 500; }
  .cell-date { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
  .cell-message { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell-channel { font-size: 12px; color: var(--text-secondary); }
  .actions-col { text-align: right; white-space: nowrap; }
  .actions-col button + button { margin-left: 4px; }
  .text-muted { color: var(--text-muted); font-size: 12px; }

  .resource-id {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin-left: 4px;
  }

  .metric-name {
    font-size: 12px;
    background: var(--bg-surface);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }

  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* ── Badges ──────────────────────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-webhook { background: var(--blue-subtle, #1e3a5f); color: var(--blue-text, #60a5fa); }
  .badge-slack { background: #2d1b4e; color: #c084fc; }
  .badge-email { background: #1b3d2f; color: #6ee7b7; }
  .badge-resource { background: var(--bg-active); color: var(--text-secondary); }

  .severity-info { background: var(--blue-subtle, #1e3a5f); color: var(--blue-text, #60a5fa); }
  .severity-warning { background: #3d2e0f; color: #fbbf24; }
  .severity-critical { background: var(--red-subtle); color: var(--red-text); }

  .badge-ack { background: var(--green-subtle, #0f3d2e); color: var(--green-text, #6ee7b7); }
  .badge-unack { background: var(--red-subtle); color: var(--red-text); }

  /* ── Toggle (small) ──────────────────────────────────────────── */
  .toggle-sm {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }
  .toggle-sm input { opacity: 0; width: 0; height: 0; }
  .slider-sm {
    position: absolute;
    inset: 0;
    background: var(--bg-active);
    border-radius: 20px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .slider-sm::before {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    left: 3px;
    bottom: 3px;
    background: var(--text-secondary);
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle-sm input:checked + .slider-sm { background: var(--accent); }
  .toggle-sm input:checked + .slider-sm::before { background: var(--text-inverse); transform: translateX(16px); }

  /* ── Inline Form ─────────────────────────────────────────────── */
  .inline-form {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 20px;
    margin-bottom: 16px;
  }

  .inline-form h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 16px;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }

  .form-row-3 {
    grid-template-columns: 1fr 1fr 1fr;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: 500;
    font-size: 12px;
    color: var(--text-primary);
  }

  .optional {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 11px;
  }

  .form-group input[type='text'],
  .form-group input[type='number'],
  .form-group select {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
    transition: border-color 0.15s;
    font-family: var(--font-sans);
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .form-actions-inline {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .empty-state {
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
    font-size: 13px;
  }

  @media (max-width: 768px) {
    .form-row, .form-row-3 {
      grid-template-columns: 1fr;
    }
  }
</style>
