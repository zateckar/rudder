<script lang="ts">
  let { data } = $props();

  let busy = $state<Record<string, boolean>>({});

  async function provisionWorker(workerId: string) {
    busy[workerId] = true;
    try {
      const response = await fetch('/api/workers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId }),
      });
      if (response.ok) {
        window.location.reload();
      } else {
        const result = await response.json();
        alert('Provisioning failed: ' + result.error);
      }
    } catch {
      alert('Provisioning failed');
    } finally {
      busy[workerId] = false;
    }
  }
</script>

<header>
  <h1>Workers</h1>
  <a href="/workers/new" class="btn-primary">Add Worker</a>
</header>

{#if data.workers.length === 0}
  <div class="empty-state">
    <div class="empty-icon">+</div>
    <p>No workers configured yet.</p>
    <a href="/workers/new" class="btn-primary">Add your first worker</a>
  </div>
{:else}
  <div class="workers-grid">
    {#each data.workers as worker (worker.id)}
      <div class="worker-card">
        <div class="worker-header">
          <a href="/workers/{worker.id}" class="worker-name">{worker.name}</a>
          <span class="status-dot {worker.status}"></span>
        </div>
        <div class="worker-details">
          <span class="detail-line">{worker.hostname}:{worker.sshPort}</span>
          {#if worker.baseDomain}
            <span class="detail-line mono">*.{worker.baseDomain}</span>
          {/if}
        </div>
        <div class="worker-footer">
          <div class="footer-left">
            {#if worker.status === 'offline' || worker.status === 'error'}
              <button
                class="btn-tiny btn-provision"
                disabled={busy[worker.id]}
                onclick={() => provisionWorker(worker.id)}
                title="Retry provisioning this worker"
              >
                Provision
              </button>
            {/if}
          </div>
          <a href="/workers/{worker.id}" class="detail-link">details &rarr;</a>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 28px;
  }

  header h1 {
    font-family: var(--font-sans);
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .btn-primary {
    display: inline-flex;
    align-items: center;
    padding: 9px 20px;
    background: var(--accent);
    color: var(--bg-root);
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 13px;
    text-decoration: none;
    transition: background 0.15s;
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .empty-state {
    background: var(--bg-surface);
    border: 1px dashed var(--border-default);
    padding: 72px 40px;
    border-radius: var(--radius-lg);
    text-align: center;
  }

  .empty-icon {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: 26px;
    line-height: 52px;
    margin: 0 auto 20px;
  }

  .empty-state p {
    color: var(--text-muted);
    margin-bottom: 24px;
    font-size: 14px;
  }

  .workers-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }

  .worker-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .worker-card:hover {
    border-color: var(--border-default);
    box-shadow: var(--shadow-md);
  }

  .worker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 8px;
  }

  .worker-name {
    font-family: var(--font-sans);
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    text-decoration: none;
    letter-spacing: -0.01em;
    transition: color 0.15s;
  }

  .worker-name:hover {
    color: var(--accent-text);
  }

  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.online {
    background: var(--green);
    box-shadow: 0 0 0 3px var(--green-subtle);
  }

  .status-dot.offline {
    background: var(--text-muted);
    box-shadow: 0 0 0 3px rgba(96, 96, 112, 0.15);
  }

  .status-dot.provisioning {
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .status-dot.error {
    background: var(--red);
    box-shadow: 0 0 0 3px var(--red-subtle);
  }

  .worker-details {
    padding: 0 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .detail-line {
    font-size: 12.5px;
    color: var(--text-secondary);
  }

  .detail-line.mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .worker-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    background: var(--bg-raised);
    border-top: 1px solid var(--border-subtle);
  }

  .footer-left {
    display: flex;
    gap: 6px;
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
    transition: background 0.15s, color 0.15s;
  }

  .btn-tiny:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-tiny:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-provision {
    color: var(--accent-text);
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .btn-provision:hover:not(:disabled) {
    background: rgba(217, 119, 6, 0.22);
  }

  .detail-link {
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
    transition: color 0.15s;
  }

  .detail-link:hover {
    color: var(--accent);
  }
</style>
