<script lang="ts">
  let { data } = $props();

  let showForm = $state(false);
  let isSubmitting = $state(false);
  let formData = $state({
    name: '',
    containerPath: '',
    teamId: '',
    workerId: '',
    sizeLimit: '',
  });

  async function createVolume(e: Event) {
    e.preventDefault();
    isSubmitting = true;
    
    try {
      const res = await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          containerPath: formData.containerPath,
          teamId: formData.teamId || null,
          workerId: formData.workerId || null,
          sizeLimit: formData.sizeLimit ? parseInt(formData.sizeLimit) : null,
        }),
      });
      
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to create volume');
      }
    } finally {
      isSubmitting = false;
    }
  }

  async function deleteVolume(volumeId: string) {
    if (!confirm('Are you sure you want to delete this volume?')) return;
    
    try {
      const res = await fetch(`/api/volumes/${volumeId}`, { method: 'DELETE' });
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to delete volume');
      }
    } catch {
      alert('Failed to delete volume');
    }
  }

  function formatSize(bytes: number | null) {
    if (!bytes) return 'Unlimited';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }

  function formatDate(date: Date) {
    return new Date(date).toLocaleDateString();
  }
</script>

<svelte:head>
  <title>Volumes - Rudder</title>
</svelte:head>

<div class="volumes-container">
  <div class="page-header">
    <div>
      <a href="/secrets" class="back-link">← Back to Secrets</a>
      <h1>Volumes</h1>
      <p class="subtitle">Manage persistent storage volumes for containers</p>
    </div>
    <button onclick={() => showForm = !showForm} class="btn-primary">
      {showForm ? 'Cancel' : '+ New Volume'}
    </button>
  </div>

  <!-- Create Form -->
  {#if showForm}
    <div class="card form-card">
      <h2>Create Volume</h2>
      <form onsubmit={createVolume}>
        <div class="form-grid">
          <div class="form-group">
            <label for="name">Volume Name *</label>
            <input
              type="text"
              id="name"
              bind:value={formData.name}
              required
              placeholder="my-volume"
            />
          </div>
          <div class="form-group">
            <label for="containerPath">Container Path *</label>
            <input
              type="text"
              id="containerPath"
              bind:value={formData.containerPath}
              required
              placeholder="/app/data"
            />
          </div>
          <div class="form-group">
            <label for="teamId">Team</label>
            <select id="teamId" bind:value={formData.teamId}>
              <option value="">No team</option>
              {#each data.teams as team}
                <option value={team.id}>{team.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="workerId">Worker</label>
            <select id="workerId" bind:value={formData.workerId}>
              <option value="">Any worker</option>
              {#each data.workers as worker}
                <option value={worker.id}>{worker.name} ({worker.hostname})</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="sizeLimit">Size Limit (GB)</label>
            <input
              type="number"
              id="sizeLimit"
              bind:value={formData.sizeLimit}
              placeholder="No limit"
              min="1"
            />
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" disabled={isSubmitting} class="btn-primary">
            {isSubmitting ? 'Creating...' : 'Create Volume'}
          </button>
        </div>
      </form>
    </div>
  {/if}

  <!-- Volumes Table -->
  <div class="card">
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Container Path</th>
          <th>Team</th>
          <th>Worker</th>
          <th>Usage</th>
          <th>Created</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.volumes as volume}
          {@const team = data.teams.find(t => t.id === volume.teamId)}
          {@const worker = data.workers.find(w => w.id === volume.workerId)}
          <tr>
            <td class="name-cell">{volume.name}</td>
            <td class="path-cell">{volume.containerPath}</td>
            <td class="text-muted">{team?.name || '-'}</td>
            <td class="text-muted">{worker?.name || 'Any'}</td>
            <td class="text-muted mono">
              {volume.actualSizeMB != null ? `${volume.actualSizeMB} MB` : '—'}
              {volume.sizeLimit ? ` / ${formatSize(volume.sizeLimit)}` : ''}
            </td>
            <td class="text-muted">{formatDate(volume.createdAt)}</td>
            <td class="text-right">
              <button onclick={() => deleteVolume(volume.id)} class="btn-danger">
                Delete
              </button>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="7" class="empty-message">
              No volumes configured yet.
              <button onclick={() => showForm = true} class="link-button">Create one</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .volumes-container {
    padding: 24px;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }

  .back-link {
    font-size: 13px;
    color: var(--text-secondary);
    text-decoration: none;
  }

  .back-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .page-header h1 {
    font-size: 28px;
    color: var(--text-primary);
    margin: 8px 0;
  }

  .subtitle {
    color: var(--text-secondary);
    font-size: 14px;
  }

  .btn-primary {
    padding: 10px 20px;
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    border-radius: var(--radius-md);
    font-weight: 500;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .card {
    background: var(--bg-raised);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
    margin-bottom: 24px;
  }

  .form-card {
    padding: 24px;
  }

  .form-card h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 20px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin-bottom: 20px;
  }

  .form-group {
    display: flex;
    flex-direction: column;
  }

  .form-group label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }

  .form-group input,
  .form-group select {
    padding: 10px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .form-group select {
    cursor: pointer;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
  }

  .data-table thead {
    background: var(--bg-overlay);
  }

  .data-table th {
    padding: 12px 16px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .data-table td {
    padding: 14px 16px;
    border-top: 1px solid var(--border-subtle);
    font-size: 14px;
    color: var(--text-primary);
  }

  .data-table tr:hover {
    background: var(--bg-hover);
  }

  .name-cell {
    font-weight: 500;
    color: var(--text-primary);
  }

  .path-cell {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-secondary);
  }

  .text-muted {
    color: var(--text-secondary);
  }

  .text-right {
    text-align: right;
  }

  .btn-danger {
    padding: 6px 12px;
    background: var(--red-subtle);
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--red-text);
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-danger:hover {
    background: var(--red);
    color: white;
  }

  .empty-message {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }

  .link-button {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 14px;
    text-decoration: underline;
    padding: 0;
  }

  .link-button:hover {
    color: var(--accent-hover);
  }

  @media (max-width: 768px) {
    .form-grid {
      grid-template-columns: 1fr;
    }

    .data-table {
      display: block;
      overflow-x: auto;
    }
  }
</style>
