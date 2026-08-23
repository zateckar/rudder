<script lang="ts">
  import { showToast } from '$lib/client/toast.svelte';

  let { data } = $props();

  let metricsInterval = $state(0);
  let savingInterval = $state(false);
  let intervalSaved = $state(false);
  let metricsRetentionDays = $state(30);
  let savingRetention = $state(false);
  let retentionSaved = $state(false);

  $effect(() => {
    metricsInterval = data.metricsInterval;
    metricsRetentionDays = data.metricsRetentionDays;
  });

  async function saveInterval() {
    savingInterval = true;
    intervalSaved = false;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics_interval_seconds: String(metricsInterval) }),
      });
      if (res.ok) {
        intervalSaved = true;
        setTimeout(() => intervalSaved = false, 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast('error', err.error || 'Failed to save the collection interval');
      }
    } finally {
      savingInterval = false;
    }
  }

  async function saveRetention() {
    savingRetention = true;
    retentionSaved = false;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics_retention_days: String(metricsRetentionDays) }),
      });
      if (res.ok) {
        retentionSaved = true;
        setTimeout(() => retentionSaved = false, 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast('error', err.error || 'Failed to save the retention period');
      }
    } finally {
      savingRetention = false;
    }
  }
</script>

<div class="settings-section">
  <h2 class="section-title">Metrics</h2>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Metrics collection interval</span>
      <span class="setting-hint">How often worker and container metrics are collected</span>
    </div>
    <div class="setting-control">
      <select bind:value={metricsInterval}>
        <option value={30}>30 seconds</option>
        <option value={60}>1 minute</option>
        <option value={120}>2 minutes</option>
        <option value={300}>5 minutes</option>
        <option value={600}>10 minutes</option>
        <option value={900}>15 minutes</option>
        <option value={1800}>30 minutes</option>
      </select>
      <button class="btn-tiny btn-save" disabled={savingInterval} onclick={saveInterval} title="Save the metrics collection interval">
        {savingInterval ? '…' : intervalSaved ? '✓' : 'Save'}
      </button>
    </div>
  </div>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Data retention</span>
      <span class="setting-hint">Metrics and pings older than this are automatically pruned. Data 7+ days old is down-sampled to 1 row/hour.</span>
    </div>
    <div class="setting-control">
      <select bind:value={metricsRetentionDays}>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
        <option value={60}>60 days</option>
        <option value={90}>90 days</option>
      </select>
      <button class="btn-tiny btn-save" disabled={savingRetention} onclick={saveRetention} title="Save the data retention period">
        {savingRetention ? '…' : retentionSaved ? '✓' : 'Save'}
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
