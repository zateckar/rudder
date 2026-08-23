<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Modal from '$lib/components/Modal.svelte';
  let { data } = $props();
  let importFileInput: HTMLInputElement;
  let importing = $state(false);
  let importError = $state('');
  let searchQuery = $state('');
  let statusFilter = $state('all');

  // Import modal
  let showImportModal = $state(false);
  let importConfig = $state<any>(null);
  let importName = $state('');
  let importTeamId = $state('');
  let importWorkerId = $state('');

  function handleImportClick() {
    importFileInput.click();
  }

  async function handleFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';

    try {
      const text = await file.text();
      const config = JSON.parse(text);
      importConfig = config;
      importName = config.name ? `${config.name}-imported` : '';
      importTeamId = data.teams?.[0]?.id || '';
      importWorkerId = data.workers?.[0]?.id || '';
      importError = '';
      showImportModal = true;
    } catch {
      importError = 'Invalid JSON file';
    }
  }

  async function doImport() {
    if (!importConfig || !importName || !importTeamId || !importWorkerId) return;
    importing = true;
    importError = '';
    try {
      const res = await fetch('/api/applications/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: importConfig,
          name: importName,
          teamId: importTeamId,
          workerId: importWorkerId,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        showImportModal = false;
        window.location.href = `/applications/${body.applicationId}`;
      } else {
        importError = body.error || 'Import failed';
      }
    } catch (e: any) {
      importError = e.message;
    } finally {
      importing = false;
    }
  }
</script>

<input type="file" accept=".json" class="hidden-file-input" bind:this={importFileInput} onchange={handleFileSelected} />

<PageHeader title="Applications">
  {#snippet actions()}
    <button class="btn-secondary" onclick={handleImportClick}>Import</button>
    <a href="/applications/new" class="btn-primary">New Application</a>
  {/snippet}
</PageHeader>

{#if importError && !showImportModal}
  <div class="import-error-banner">{importError}</div>
{/if}

<!-- Import modal -->
<Modal bind:open={showImportModal} title="Import Application">
  <p class="modal-help">Configure the imported application before creating it.</p>

  {#if importError}
    <div class="import-error">{importError}</div>
  {/if}

  {#if importConfig}
    <div class="import-preview">
      <span class="import-preview-label">Source:</span>
      <span class="import-preview-value">{importConfig.type} &middot; {importConfig.gitRepo ? 'Git' : 'Image'}</span>
    </div>
  {/if}

  <div class="form-group">
    <label for="importName">Application Name <span class="required">*</span></label>
    <input type="text" id="importName" bind:value={importName} placeholder="my-imported-app" />
  </div>

  <div class="form-group">
    <label for="importTeamId">Team <span class="required">*</span></label>
    <select id="importTeamId" bind:value={importTeamId}>
      <option value="">Select a team...</option>
      {#each data.teams as team}
        <option value={team.id}>{team.name}</option>
      {/each}
    </select>
  </div>

  <div class="form-group">
    <label for="importWorkerId">Worker <span class="required">*</span></label>
    <select id="importWorkerId" bind:value={importWorkerId}>
      <option value="">Select a worker...</option>
      {#each data.workers as worker}
        <option value={worker.id}>{worker.name} ({worker.hostname})</option>
      {/each}
    </select>
  </div>

  <div class="modal-actions">
    <button class="btn-secondary" onclick={() => showImportModal = false}>Cancel</button>
    <button class="btn-primary" onclick={doImport} disabled={importing || !importName || !importTeamId || !importWorkerId}>
      {importing ? 'Importing...' : 'Import Application'}
    </button>
  </div>
</Modal>

{#if data.applications.length === 0}
  <div class="empty-state">
    <div class="empty-icon">+</div>
    <p>No applications deployed yet.</p>
    <a href="/applications/new" class="btn-primary">Deploy your first application</a>
  </div>
{:else}
  <div class="filters-bar">
    <input type="text" class="search-input" placeholder="Search applications..." bind:value={searchQuery} />
    <select class="status-filter" bind:value={statusFilter}>
      <option value="all">All Status</option>
      <option value="running">Running</option>
      <option value="stopped">Stopped</option>
      <option value="partial">Partial</option>
    </select>
  </div>
  {@const filteredApps = data.applications.filter((app: any) => {
    const matchesSearch = !searchQuery || app.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || app.status?.label === statusFilter;
    return matchesSearch && matchesStatus;
  })}
  {#if filteredApps.length === 0}
    <div class="empty-state">
      <p>No applications match your search.</p>
    </div>
  {:else}
  <div class="applications-list">
    {#each filteredApps as app}
      {@const team = data.teams?.find((t: any) => t.id === app.teamId)}
      <div class="app-row {app.status.color}">
        <div class="app-status">
          <span class="status-dot {app.status.color}" title={app.status.label}></span>
        </div>
        <div class="app-main">
          <a href="/applications/{app.id}" class="app-name">{app.name}</a>
          {#if app.description}
            <p class="app-desc">{app.description}</p>
          {/if}
        </div>
        <div class="app-team">
          {#if team}
            <span class="team-tag">{team.name}</span>
          {/if}
        </div>
        <div class="app-links">
          {#if app.type === 'compose' && app.serviceUrls && app.serviceUrls.length > 0}
            <div class="service-urls-list">
              {#each app.serviceUrls as svc}
                <a href={svc.url} target="_blank" rel="noopener" class="app-url" title={svc.url}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8.5V13.5C13 14.0523 12.5523 14.5 12 14.5H2.5C1.94772 14.5 1.5 14.0523 1.5 13.5V4C1.5 3.44772 1.94772 3 2.5 3H7.5M14.5 1.5L8.5 7.5M14.5 1.5H10.5M14.5 1.5V5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  {svc.url.replace('https://', '').replace('http://', '')}
                </a>
              {/each}
            </div>
          {:else if app.appUrl}
            <a href={app.appUrl} target="_blank" rel="noopener" class="app-url" title={app.appUrl}>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8.5V13.5C13 14.0523 12.5523 14.5 12 14.5H2.5C1.94772 14.5 1.5 14.0523 1.5 13.5V4C1.5 3.44772 1.94772 3 2.5 3H7.5M14.5 1.5L8.5 7.5M14.5 1.5H10.5M14.5 1.5V5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {app.appUrl.replace('https://', '').replace('http://', '')}
            </a>
          {:else}
            <span class="app-url muted">no url</span>
          {/if}
        </div>
        <div class="app-actions">
          <a href="/applications/{app.id}" class="btn-open" title="Manage">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </a>
        </div>
      </div>
    {/each}
  </div>
  {/if}
{/if}

<style>
  .filters-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
  }
  .search-input {
    flex: 1;
    padding: 8px 14px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .status-filter {
    padding: 8px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
  }

  .empty-icon {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--accent-subtle);
    color: var(--accent);
    line-height: 52px;
    margin: 0 auto 16px;
  }

  .empty-state p {
    margin-bottom: 20px;
  }

  /* ── List ────────────────────────────────────── */
  .applications-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .app-row {
    display: grid;
    grid-template-columns: 24px 1fr 120px 1.5fr 40px;
    align-items: center;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 8px 16px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  }

  .app-row:hover {
    background: var(--bg-raised);
    border-color: var(--border-default);
    transform: translateX(4px);
    box-shadow: var(--shadow-md);
  }

  .app-row::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--border-default);
    transition: background 0.2s;
  }

  .app-row.green::before  { background: var(--green); }
  .app-row.red::before    { background: var(--red); }
  .app-row.orange::before { background: var(--yellow); }
  .app-row.gray::before   { background: var(--text-muted); }

  .app-status {
    display: flex;
    align-items: center;
  }

  .app-main {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }

  .app-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    text-decoration: none;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .app-name:hover {
    color: var(--accent-text);
  }

  .team-tag {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--bg-overlay);
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
  }
  .app-team {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 20px;
  }

  .app-desc {
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 400px;
  }

  .app-links {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .service-urls-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .app-url {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--accent-text);
    text-decoration: none;
    font-family: var(--font-mono);
    padding: 2px 6px;
    background: var(--accent-subtle);
    border-radius: var(--radius-sm);
    transition: all 0.15s;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .app-url:hover {
    background: var(--accent);
    color: var(--bg-root);
  }

  .app-url.muted {
    background: var(--bg-overlay);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-style: italic;
  }

  .app-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn-open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 6px;
    border-radius: var(--radius-sm);
    transition: all 0.15s;
  }

  .btn-open:hover {
    color: var(--text-primary);
    background: var(--bg-overlay);
  }

  .btn-open svg {
    transition: transform 0.15s;
  }

  .btn-open:hover svg {
    color: var(--accent);
  }

  /* ── Status dot ──────────────────────────────── */

  .status-dot.green {
    background: var(--green);
    box-shadow: 0 0 8px var(--green);
  }

  .status-dot.red {
    background: var(--red);
    box-shadow: 0 0 8px var(--red);
  }

  .status-dot.orange {
    background: var(--yellow);
    box-shadow: 0 0 8px var(--yellow);
  }

  .status-dot.gray {
    background: var(--text-muted);
  }

  /* ── Header buttons ─────────────────────────── */
  .hidden-file-input {
    display: none;
  }

  /* ── Import modal ───────────────────────────── */
  .import-error-banner {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    padding: 10px 16px;
    font-size: 13px;
    margin-bottom: 16px;
  }

  .modal-help {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 16px;
  }

  .import-error {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-size: 13px;
    margin-bottom: 12px;
  }

  .import-preview {
    background: var(--bg-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .import-preview-label {
    color: var(--text-muted);
    font-weight: 500;
  }

  .import-preview-value {
    color: var(--text-primary);
    font-weight: 600;
  }

  .modal .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
