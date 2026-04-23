<script lang="ts">
  import { browser } from '$app/environment';

  let { data } = $props();

  let stacks = $state<any[]>([]);
  let loading = $state(true);
  let showNewForm = $state(false);
  let newName = $state('');
  let newDescription = $state('');
  let newTeamId = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Detail view
  let selectedStack = $state<any>(null);
  let stackDetail = $state<any>(null);
  let loadingDetail = $state(false);
  let bulkActioning = $state<string | null>(null);

  $effect(() => {
    if (!browser) return;
    if (data.teams.length > 0 && !newTeamId) {
      newTeamId = data.teams[0].id;
    }
    loadStacks();
  });

  async function loadStacks() {
    loading = true;
    try {
      const res = await fetch('/api/stacks');
      if (res.ok) {
        stacks = await res.json();
      }
    } catch (e) {
      console.error('Failed to load stacks:', e);
    } finally {
      loading = false;
    }
  }

  async function createStack() {
    saving = true;
    error = null;
    try {
      const res = await fetch('/api/stacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, description: newDescription, teamId: newTeamId }),
      });
      const result = await res.json();
      if (!res.ok) {
        error = result.error || 'Failed to create stack';
      } else {
        newName = '';
        newDescription = '';
        showNewForm = false;
        await loadStacks();
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  async function deleteStack(id: string) {
    if (!confirm('Delete this stack? Applications will be unlinked but not deleted.')) return;
    try {
      const res = await fetch(`/api/stacks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        stacks = stacks.filter(s => s.id !== id);
        if (selectedStack?.id === id) {
          selectedStack = null;
          stackDetail = null;
        }
      }
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function selectStack(stack: any) {
    selectedStack = stack;
    loadingDetail = true;
    try {
      const res = await fetch(`/api/stacks/${stack.id}`);
      if (res.ok) {
        stackDetail = await res.json();
      }
    } catch (e) {
      console.error('Failed to load stack detail:', e);
    } finally {
      loadingDetail = false;
    }
  }

  async function bulkAction(action: string) {
    if (!selectedStack) return;
    bulkActioning = action;
    try {
      const res = await fetch(`/api/stacks/${selectedStack.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const result = await res.json();
      if (result.success) {
        // Refresh detail
        await selectStack(selectedStack);
      } else {
        alert(result.message || 'Action failed');
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      bulkActioning = null;
    }
  }

  async function removeAppFromStack(appId: string) {
    if (!confirm('Remove this application from the stack?')) return;
    try {
      // Use the application edit endpoint to unset stackId
      const res = await fetch(`/api/stacks/${selectedStack.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeAppId: appId }),
      });
      // Alternatively, directly update the application
      const updateRes = await fetch(`/api/containers/${appId}`, { method: 'GET' }); // just refresh
      // Actually, let's use a direct DB approach via a small endpoint
      // For simplicity, we'll PATCH the stack to remove the app
      await selectStack(selectedStack);
      await loadStacks();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function removeAppDirect(appId: string) {
    if (!confirm('Remove this application from the stack?')) return;
    try {
      // We'll update the application's stackId to null via fetch
      const res = await fetch(`/api/stacks/${selectedStack.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeAppId: appId }),
      });
      if (res.ok) {
        await selectStack(selectedStack);
        await loadStacks();
      }
    } catch (e: any) {
      alert(e.message);
    }
  }

  function getStatusColor(status: string): string {
    if (status === 'running') return 'var(--green-text, #6ee7b7)';
    if (status === 'exited' || status === 'stopped') return 'var(--red-text)';
    return 'var(--text-muted)';
  }
</script>

<div class="stacks-page">

<header>
  <div class="header-top">
    <div>
      <h1>Application Stacks</h1>
      <p class="subtitle">Group applications for bulk operations</p>
    </div>
    <button class="btn-primary" onclick={() => { showNewForm = !showNewForm; error = null; }}>
      {showNewForm ? 'Cancel' : '+ New Stack'}
    </button>
  </div>
</header>

{#if error}
  <div class="alert alert-error">{error}</div>
{/if}

{#if showNewForm}
  <section class="section">
    <h3 class="form-title">Create New Stack</h3>
    <form onsubmit={(e) => { e.preventDefault(); createStack(); }}>
      <div class="form-row">
        <div class="form-group">
          <label for="stack-name">Stack Name</label>
          <input type="text" id="stack-name" bind:value={newName} placeholder="e.g. Production Services" required />
        </div>
        <div class="form-group">
          <label for="stack-team">Team</label>
          <select id="stack-team" bind:value={newTeamId}>
            {#each data.teams as team}
              <option value={team.id}>{team.name}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label for="stack-desc">Description</label>
        <input type="text" id="stack-desc" bind:value={newDescription} placeholder="Optional description" />
      </div>
      <div class="form-actions-inline">
        <button type="submit" class="btn-primary btn-sm" disabled={saving || !newName || !newTeamId}>
          {saving ? 'Creating...' : 'Create Stack'}
        </button>
        <button type="button" class="btn-ghost btn-sm" onclick={() => showNewForm = false}>Cancel</button>
      </div>
    </form>
  </section>
{/if}

<div class="stacks-layout">
  <!-- Stack list -->
  <div class="stacks-list">
    {#if loading}
      <div class="empty-state">Loading stacks...</div>
    {:else if stacks.length === 0}
      <div class="empty-state">No stacks yet. Create one to group your applications.</div>
    {:else}
      {#each stacks as stack (stack.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="stack-card"
          class:active={selectedStack?.id === stack.id}
          onclick={() => selectStack(stack)}
        >
          <div class="stack-card-header">
            <h3>{stack.name}</h3>
            <button
              class="btn-icon btn-icon-danger"
              title="Delete stack"
              onclick={(e) => { e.stopPropagation(); deleteStack(stack.id); }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M6 6.5v3M8 6.5v3M4 4l.5 7a1 1 0 001 1h3a1 1 0 001-1L10 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          {#if stack.description}
            <p class="stack-desc">{stack.description}</p>
          {/if}
          <div class="stack-meta">
            <span class="badge badge-team">{stack.teamName}</span>
            <span class="app-count">{stack.appCount} app{stack.appCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Stack detail -->
  <div class="stack-detail">
    {#if !selectedStack}
      <div class="empty-state">Select a stack to view its applications</div>
    {:else if loadingDetail}
      <div class="empty-state">Loading...</div>
    {:else if stackDetail}
      <div class="detail-header">
        <div>
          <h2>{stackDetail.name}</h2>
          {#if stackDetail.description}
            <p class="subtitle">{stackDetail.description}</p>
          {/if}
        </div>
        <div class="bulk-actions">
          <button
            class="btn-deploy btn-sm"
            onclick={() => bulkAction('deploy')}
            disabled={bulkActioning !== null}
          >
            {bulkActioning === 'deploy' ? 'Deploying...' : 'Deploy All'}
          </button>
          <button
            class="btn-warning btn-sm"
            onclick={() => bulkAction('restart')}
            disabled={bulkActioning !== null}
          >
            {bulkActioning === 'restart' ? 'Restarting...' : 'Restart All'}
          </button>
          <button
            class="btn-danger btn-sm"
            onclick={() => bulkAction('stop')}
            disabled={bulkActioning !== null}
          >
            {bulkActioning === 'stop' ? 'Stopping...' : 'Stop All'}
          </button>
        </div>
      </div>

      {#if stackDetail.applications.length === 0}
        <div class="empty-state">
          No applications in this stack yet. Assign applications from their edit page.
        </div>
      {:else}
        <div class="app-list">
          {#each stackDetail.applications as app (app.id)}
            <div class="app-card">
              <div class="app-info">
                <a href="/applications/{app.id}" class="app-name">{app.name}</a>
                <div class="app-meta">
                  {#if app.workerName}
                    <span class="meta-item">{app.workerName}</span>
                  {/if}
                  {#if app.type === 'compose' && app.serviceUrls && app.serviceUrls.length > 0}
                    {#each app.serviceUrls as svc}
                      <a href={svc.url} target="_blank" rel="noopener" class="meta-item mono stack-app-url">{svc.url}</a>
                    {/each}
                  {:else if app.appUrl}
                    <a href={app.appUrl} target="_blank" rel="noopener" class="meta-item mono stack-app-url">{app.appUrl}</a>
                  {:else if app.domain}
                    <span class="meta-item mono">{app.domain}</span>
                  {/if}
                </div>
              </div>
              <div class="app-status">
                {#if app.containers.length > 0}
                  {#each app.containers as container}
                    <span class="container-status" style="color: {getStatusColor(container.status)}">
                      {container.status}
                    </span>
                  {/each}
                {:else}
                  <span class="container-status" style="color: var(--text-muted)">not deployed</span>
                {/if}
              </div>
              <button
                class="btn-ghost btn-sm"
                onclick={() => removeAppDirect(app.id)}
              >
                Remove
              </button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

</div>

<style>
  header { margin-bottom: 24px; }
  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  header h1 { font-size: 26px; color: var(--text-primary); margin: 0 0 6px; }
  .subtitle { color: var(--text-secondary); font-size: 14px; margin: 0; }

  .alert {
    padding: 12px 16px;
    border-radius: var(--radius-sm);
    margin-bottom: 16px;
    font-size: 14px;
  }
  .alert-error {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
  }

  .section {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin-bottom: 24px;
  }

  .form-title {
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

  .form-group input[type='text'],
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

  .stacks-layout {
    display: grid;
    grid-template-columns: 350px 1fr;
    gap: 24px;
    min-height: 400px;
  }

  .stacks-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .stack-card {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 16px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    width: 100%;
    color: inherit;
    font-family: inherit;
  }

  .stack-card:hover {
    border-color: var(--border-default);
    background: var(--bg-hover);
  }

  .stack-card.active {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .stack-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .stack-card h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .stack-desc {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0 0 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stack-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-team {
    background: var(--bg-active);
    color: var(--text-secondary);
  }

  .app-count {
    font-size: 12px;
    color: var(--text-muted);
  }

  .stack-detail {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 24px;
    min-height: 300px;
  }

  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .detail-header h2 {
    font-size: 20px;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .bulk-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .app-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .app-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    transition: all 0.12s;
  }

  .app-card:hover {
    border-color: var(--border-default);
  }

  .app-info {
    flex: 1;
    min-width: 0;
  }

  .app-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--accent-text);
    text-decoration: none;
    transition: color 0.12s;
  }

  .app-name:hover {
    color: var(--accent);
  }

  .app-meta {
    display: flex;
    gap: 12px;
    margin-top: 4px;
  }

  .meta-item {
    font-size: 12px;
    color: var(--text-muted);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .stack-app-url {
    color: var(--accent-text);
    text-decoration: none;
    transition: color 0.12s;
  }
  .stack-app-url:hover {
    text-decoration: underline;
  }

  .app-status {
    display: flex;
    gap: 6px;
    margin: 0 16px;
  }

  .container-status {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

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

  .btn-deploy {
    padding: 6px 12px;
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-deploy:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-deploy:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-warning {
    padding: 6px 12px;
    background: #b45309;
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn-warning:hover:not(:disabled) { opacity: 0.9; }
  .btn-warning:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-danger {
    padding: 6px 12px;
    background: var(--red);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn-danger:hover:not(:disabled) { opacity: 0.9; }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

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
    flex-shrink: 0;
  }
  .btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-icon-danger:hover { background: var(--red-subtle); color: var(--red-text); border-color: var(--red); }

  .empty-state {
    text-align: center;
    padding: 40px 16px;
    color: var(--text-muted);
    font-size: 13px;
  }

  @media (max-width: 768px) {
    .stacks-layout {
      grid-template-columns: 1fr;
    }
    .form-row {
      grid-template-columns: 1fr;
    }
    .bulk-actions {
      flex-wrap: wrap;
    }
  }
</style>
