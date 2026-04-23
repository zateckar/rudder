<script lang="ts">
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

<header>
  <h1>Applications</h1>
  <div class="header-buttons">
    <button class="btn-secondary" onclick={handleImportClick}>Import</button>
    <a href="/applications/new" class="btn-primary">New Application</a>
  </div>
</header>

{#if importError && !showImportModal}
  <div class="import-error-banner">{importError}</div>
{/if}

<!-- Import modal -->
{#if showImportModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showImportModal = false} onkeydown={(e) => e.key === 'Escape' && (showImportModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Import Application</h3>
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
    </div>
  </div>
{/if}

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
  <div class="applications-grid">
    {#each filteredApps as app}
      {@const team = data.teams?.find((t: any) => t.id === app.teamId)}
      <div class="card {app.status.color}">
        <div class="card-body">
          <div class="card-top">
            <a href="/applications/{app.id}" class="app-name">{app.name}</a>
            <span class="status-dot {app.status.color}" title={app.status.label}></span>
          </div>
          {#if app.type === 'compose' && app.serviceUrls && app.serviceUrls.length > 0}
            <div class="service-urls-list">
              {#each app.serviceUrls as svc}
                <a href={svc.url} target="_blank" rel="noopener" class="app-url">{svc.name}: {svc.url}</a>
              {/each}
            </div>
          {:else if app.appUrl}
            <a href={app.appUrl} target="_blank" rel="noopener" class="app-url">{app.appUrl}</a>
          {:else}
            <span class="app-url muted">no url</span>
          {/if}
          {#if app.description}
            <p class="app-desc">{app.description}</p>
          {/if}
        </div>
        <div class="card-footer">
          {#if team}
            <span class="team-tag">{team.name}</span>
          {/if}
          <a href="/applications/{app.id}" class="detail-link">open &rarr;</a>
        </div>
      </div>
    {/each}
  </div>
  {/if}
{/if}

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 28px;
  }

  header h1 {
    font-size: 26px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .filters-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
  }
  .search-input {
    flex: 1;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .status-filter {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
  }

  .btn-primary {
    padding: 9px 18px;
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
    background: var(--bg-raised);
    border: 1px dashed var(--border-default);
    padding: 60px;
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
    margin: 0 auto 16px;
  }

  .empty-state p {
    color: var(--text-secondary);
    margin-bottom: 20px;
    font-size: 14px;
  }

  /* ── Grid ────────────────────────────────────── */

  .applications-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }

  /* ── Card ────────────────────────────────────── */

  .card {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--border-default);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    overflow: hidden;
  }

  .card:hover {
    background: var(--bg-hover);
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.25);
  }

  .card.green  { border-left-color: var(--green); }
  .card.red    { border-left-color: var(--red); }
  .card.orange { border-left-color: var(--yellow); }
  .card.gray   { border-left-color: var(--text-muted); }

  .card-body {
    padding: 18px 20px 12px;
  }

  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .app-name {
    font-size: 16px;
    font-weight: 650;
    color: var(--text-primary);
    text-decoration: none;
    letter-spacing: -0.01em;
    transition: color 0.15s;
  }

  .app-name:hover {
    color: var(--accent-text);
  }

  /* ── Status dot ──────────────────────────────── */

  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.green {
    background: var(--green);
    box-shadow: 0 0 0 3px var(--green-subtle);
  }

  .status-dot.red {
    background: var(--red);
    box-shadow: 0 0 0 3px var(--red-subtle);
  }

  .status-dot.orange {
    background: var(--yellow);
    box-shadow: 0 0 0 3px var(--yellow-subtle);
  }

  .status-dot.gray {
    background: var(--text-muted);
    box-shadow: 0 0 0 3px rgba(96, 96, 112, 0.2);
  }

  /* ── URL ─────────────────────────────────────── */

  .app-url {
    display: block;
    font-size: 12.5px;
    color: var(--accent-text);
    text-decoration: none;
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s;
  }

  .app-url:hover {
    color: var(--accent-hover);
    text-decoration: underline;
  }

  .app-url.muted {
    color: var(--text-muted);
    font-style: italic;
    font-family: inherit;
  }

  .service-urls-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .app-desc {
    font-size: 12.5px;
    color: var(--text-secondary);
    margin: 4px 0 0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ── Footer ──────────────────────────────────── */

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    background: var(--bg-overlay);
    border-top: 1px solid var(--border-subtle);
  }

  .team-tag {
    font-size: 11px;
    color: var(--accent);
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    background: var(--accent-subtle);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }

  .detail-link {
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
    transition: color 0.15s;
  }

  .detail-link:hover {
    color: var(--accent-text);
  }

  /* ── Header buttons ─────────────────────────── */

  .header-buttons {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn-secondary {
    padding: 9px 18px;
    background: var(--bg-raised);
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
  }

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

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-surface, var(--bg-raised));
    padding: 28px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-default);
    width: 100%;
    max-width: 460px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }

  .modal h3 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
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

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .required {
    color: var(--red);
  }

  .form-group input[type='text'],
  .form-group select {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .form-group select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239898a8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }

  .modal .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
