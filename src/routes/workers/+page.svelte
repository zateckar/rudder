<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { invalidateAll } from '$app/navigation';
  import SshKeyPrompt from '$lib/components/SshKeyPrompt.svelte';
  import { showToast } from '$lib/client/toast.svelte';

  let { data } = $props();

  let busy = $state<Record<string, boolean>>({});
  let showProvisionModal = $state(false);
  let provisionTargetId = $state('');
  function requestProvision(workerId: string) {
    provisionTargetId = workerId;
    showProvisionModal = true;
  }

  async function provisionWorker(sshKey: string) {
    const workerId = provisionTargetId;
    showProvisionModal = false;
    busy[workerId] = true;
    try {
      const response = await fetch('/api/workers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId, sshPrivateKey: sshKey }),
      });
      if (response.ok) {
        invalidateAll();
      } else {
        const result = await response.json().catch(() => ({}));
        showToast('error', `Provisioning failed: ${result.error ?? `HTTP ${response.status}`}`);
      }
    } catch (e: any) {
      showToast('error', `Provisioning failed: ${e.message}`);
    } finally {
      busy[workerId] = false;
    }
  }
</script>

<PageHeader title="Workers">
  {#snippet actions()}
    <a href="/workers/new" class="btn-primary">Add Worker</a>
  {/snippet}
</PageHeader>

{#if data.workers.length === 0}
  <div class="empty-state">
    <div class="empty-icon">+</div>
    <p>No workers configured yet.</p>
    <a href="/workers/new" class="btn-primary">Add your first worker</a>
  </div>
{:else}
  <div class="worker-list">
    {#each data.workers as worker (worker.id)}
      <div class="worker-row {worker.status}">
        <div class="worker-status">
          <span class="status-dot {worker.status}" title={worker.status}></span>
        </div>
        <div class="worker-main">
          <a href="/workers/{worker.id}" class="worker-name">{worker.name}</a>
          <div class="worker-meta">
            <span class="worker-host">{worker.hostname}:{worker.sshPort}</span>
          </div>
        </div>
        <div class="worker-domain">
          {#if worker.baseDomain}
            <span class="domain-tag">*.{worker.baseDomain}</span>
          {:else}
            <span class="muted">no domain</span>
          {/if}
        </div>
        <div class="worker-actions">
          {#if worker.status === 'offline' || worker.status === 'error'}
            <button
              class="btn-action btn-provision"
              disabled={busy[worker.id]}
              onclick={() => requestProvision(worker.id)}
              title="Retry provisioning"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8C2 4.68629 4.68629 2 8 2C9.65685 2 11.1569 2.67157 12.2426 3.75736M14 2V5H11" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Provision
            </button>
          {/if}
          <a href="/workers/{worker.id}" class="btn-details">
            Details
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
        </div>
      </div>
    {/each}
  </div>
{/if}

{#if showProvisionModal}
<SshKeyPrompt
  workerId={provisionTargetId}
  title="Provision Worker"
  description="Paste the SSH private key for root access. This key is used only for this provisioning session and is <strong>never stored</strong> on the server."
  submitLabel="Start Provisioning"
  onsubmit={provisionWorker}
  oncancel={() => showProvisionModal = false}
/>
{/if}

<style>
  /* Modal styles moved to SshKeyPrompt component */
  .empty-icon {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--accent-subtle);
    color: var(--accent);
    line-height: 52px;
    margin: 0 auto 20px;
  }

  .empty-state p {
    margin-bottom: 24px;
  }

  .worker-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .worker-row {
    display: grid;
    grid-template-columns: 32px 1.5fr 1fr 1.5fr;
    align-items: center;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 14px 20px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  }

  .worker-row:hover {
    background: var(--bg-raised);
    border-color: var(--border-default);
    transform: translateX(4px);
    box-shadow: var(--shadow-md);
  }

  .worker-row::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--border-default);
    transition: background 0.2s;
  }

  .worker-row.online::before { background: var(--green); }
  .worker-row.error::before { background: var(--red); }
  .worker-row.provisioning::before { background: var(--accent); }
  .worker-row.offline::before { background: var(--text-muted); }

  .worker-status {
    display: flex;
    align-items: center;
  }

  .worker-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .worker-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    text-decoration: none;
    letter-spacing: -0.01em;
  }

  .worker-name:hover {
    color: var(--accent-text);
  }

  .worker-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .worker-domain {
    display: flex;
    align-items: center;
  }

  .domain-tag {
    font-size: 12px;
    color: var(--accent-text);
    background: var(--accent-subtle);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
  }

  .worker-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
  }

  .btn-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--bg-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    transition: all 0.15s;
    cursor: pointer;
  }

  .btn-action:hover:not(:disabled) {
    background: var(--bg-active);
    color: var(--text-primary);
    border-color: var(--border-default);
  }

  .btn-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-provision {
    color: var(--accent-text);
    border-color: var(--accent-subtle);
    background: var(--accent-subtle);
  }

  .btn-provision:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg-root);
    border-color: var(--accent);
  }

  .btn-details {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    transition: all 0.15s;
    text-decoration: none;
  }

  .btn-details:hover {
    color: var(--text-primary);
    background: var(--bg-overlay);
  }

  .btn-details svg {
    transition: transform 0.15s;
  }

  .btn-details:hover svg {
    transform: translateX(2px);
  }

  /* ── Status dot ──────────────────────────────── */

  .status-dot.online {
    background: var(--green);
    box-shadow: 0 0 8px var(--green);
  }

  .status-dot.offline {
    background: var(--text-muted);
  }

  .status-dot.provisioning {
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
  }

  .status-dot.error {
    background: var(--red);
    box-shadow: 0 0 8px var(--red);
  }

  .muted {
    font-size: 12px;
    font-style: italic;
  }
</style>
