<script lang="ts">
  import { showToast } from '$lib/client/toast.svelte';

  let { data } = $props();

  /**
   * Every setting on this page, by the key it is stored under.
   *
   * One record rather than three `$state` variables per row. There were three
   * rows and three near-identical save functions differing by one key and one
   * error message, and this page is going to keep growing — the fourth and
   * fifth are below.
   */
  let values = $state<Record<string, number>>({});
  let saving = $state<Record<string, boolean>>({});
  let saved = $state<Record<string, boolean>>({});

  $effect(() => {
    values = {
      metrics_interval_seconds: data.metricsInterval,
      metrics_retention_days: data.metricsRetentionDays,
      alert_interval_seconds: data.alertInterval,
      audit_log_retention_days: data.auditLogRetentionDays,
      alert_event_retention_days: data.alertEventRetentionDays,
    };
  });

  async function save(key: string, label: string) {
    saving[key] = true;
    saved[key] = false;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: String(values[key]) }),
      });
      if (res.ok) {
        saved[key] = true;
        setTimeout(() => (saved[key] = false), 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast('error', err.error || `Failed to save the ${label}`);
      }
    } finally {
      saving[key] = false;
    }
  }
</script>

<div class="settings-section">
  <h2 class="section-title">Metrics</h2>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Metrics collection interval</span>
      <span class="setting-hint">
        How often worker and container metrics are collected. Drift detection runs on the
        same cycle, because it reuses the container listing this sweep already fetches —
        so a long interval also means drift is noticed less often. Alerting has its own
        interval below.
      </span>
    </div>
    <div class="setting-control">
      <select bind:value={values.metrics_interval_seconds}>
        <option value={30}>30 seconds</option>
        <option value={60}>1 minute</option>
        <option value={120}>2 minutes</option>
        <option value={300}>5 minutes</option>
        <option value={600}>10 minutes</option>
        <option value={900}>15 minutes</option>
        <option value={1800}>30 minutes</option>
      </select>
      <button
        class="btn-tiny btn-save"
        disabled={saving.metrics_interval_seconds}
        onclick={() => save('metrics_interval_seconds', 'collection interval')}
        title="Save the metrics collection interval"
      >
        {saving.metrics_interval_seconds ? '…' : saved.metrics_interval_seconds ? '✓' : 'Save'}
      </button>
    </div>
  </div>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Data retention</span>
      <span class="setting-hint">Metrics and pings older than this are automatically pruned. Data 7+ days old is down-sampled to 1 row/hour.</span>
    </div>
    <div class="setting-control">
      <select bind:value={values.metrics_retention_days}>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
        <option value={60}>60 days</option>
        <option value={90}>90 days</option>
      </select>
      <button
        class="btn-tiny btn-save"
        disabled={saving.metrics_retention_days}
        onclick={() => save('metrics_retention_days', 'retention period')}
        title="Save the data retention period"
      >
        {saving.metrics_retention_days ? '…' : saved.metrics_retention_days ? '✓' : 'Save'}
      </button>
    </div>
  </div>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Alert evaluation interval</span>
      <span class="setting-hint">
        How often alert rules are checked against the latest metrics, and so the worst case
        delay before an alert fires. Independent of the collection interval above: checking
        more often than metrics arrive is harmless, since a rule that has fired is suppressed
        for five minutes.
      </span>
    </div>
    <div class="setting-control">
      <select bind:value={values.alert_interval_seconds}>
        <option value={30}>30 seconds</option>
        <option value={60}>1 minute</option>
        <option value={120}>2 minutes</option>
        <option value={300}>5 minutes</option>
        <option value={600}>10 minutes</option>
        <option value={1800}>30 minutes</option>
      </select>
      <button
        class="btn-tiny btn-save"
        disabled={saving.alert_interval_seconds}
        onclick={() => save('alert_interval_seconds', 'alert interval')}
        title="Save the alert evaluation interval"
      >
        {saving.alert_interval_seconds ? '…' : saved.alert_interval_seconds ? '✓' : 'Save'}
      </button>
    </div>
  </div>
</div>

<div class="settings-section">
  <h2 class="section-title">History</h2>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Audit log retention</span>
      <span class="setting-hint">
        How long the record of who did what is kept. Swept once a day, in batches. This is
        the log anyone asks for after an incident, so it defaults to a year — shorten it
        only if you have somewhere else to keep it.
      </span>
    </div>
    <div class="setting-control">
      <select bind:value={values.audit_log_retention_days}>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
        <option value={180}>180 days</option>
        <option value={365}>1 year</option>
        <option value={730}>2 years</option>
      </select>
      <button
        class="btn-tiny btn-save"
        disabled={saving.audit_log_retention_days}
        onclick={() => save('audit_log_retention_days', 'audit log retention')}
        title="Save the audit log retention period"
      >
        {saving.audit_log_retention_days ? '…' : saved.audit_log_retention_days ? '✓' : 'Save'}
      </button>
    </div>
  </div>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Alert history retention</span>
      <span class="setting-hint">
        How long fired alerts are kept. Whether one was acknowledged does not extend this:
        an alert nobody acted on in three months is not waiting to be acted on.
      </span>
    </div>
    <div class="setting-control">
      <select bind:value={values.alert_event_retention_days}>
        <option value={7}>7 days</option>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
        <option value={180}>180 days</option>
        <option value={365}>1 year</option>
      </select>
      <button
        class="btn-tiny btn-save"
        disabled={saving.alert_event_retention_days}
        onclick={() => save('alert_event_retention_days', 'alert history retention')}
        title="Save the alert history retention period"
      >
        {saving.alert_event_retention_days ? '…' : saved.alert_event_retention_days ? '✓' : 'Save'}
      </button>
    </div>
  </div>
</div>

<style>
  .settings-section {
    background: var(--bg-raised);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    padding: 20px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 16px;
  }

  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
  }

  .setting-info { display: flex; flex-direction: column; gap: 2px; }
  .setting-label { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .setting-hint { font-size: 12px; color: var(--text-muted); }

  .setting-control { display: flex; align-items: center; gap: 8px; }

  .setting-control select {
    padding: 6px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-input);
    color: var(--text-primary);
  }

  .btn-tiny {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-default);
    background: var(--bg-raised);
    color: var(--text-secondary);
  }

  .btn-tiny:hover:not(:disabled) { background: var(--bg-hover); }

  .btn-tiny:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-save {
    color: var(--accent-text);
    background: var(--accent-subtle);
  }

  .setting-row + .setting-row {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }
</style>
