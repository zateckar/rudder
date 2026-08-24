<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { formatDate } from '$lib/format';
  import { invalidateAll } from '$app/navigation';
  import { showToast } from '$lib/client/toast.svelte';
  import { confirmAction } from '$lib/client/dialog.svelte';

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
          teamId: formData.teamId,
          workerId: formData.workerId || null,
          sizeLimit: formData.sizeLimit ? parseInt(formData.sizeLimit) : null,
        }),
      });
      
      if (res.ok) {
        invalidateAll();
      } else {
        const err = await res.json();
        showToast('error', err.error || 'Failed to create volume');
      }
    } finally {
      isSubmitting = false;
    }
  }

  /**
   * Delete the entry, and — separately — the data.
   *
   * These are two different things, and the dialog used to offer only the first
   * while stating the second as a reassurance: "Data already written on the
   * worker is not deleted." True, and the reason the whole feature was a way to
   * lose track of disk rather than reclaim it. Both outcomes are offered, and
   * the destructive one has to be picked deliberately.
   */
  async function deleteVolume(volume: { id: string; name: string; usedBy?: string[] }, withData: boolean) {
    const inUse = volume.usedBy?.length
      ? ` It is mounted by ${volume.usedBy.map((n) => `"${n}"`).join(', ')}.`
      : '';
    const ok = await confirmAction({
      title: withData ? `Delete "${volume.name}" and its data?` : 'Remove this registry entry?',
      body: withData
        ? `Everything written to this volume is deleted from the worker.${inUse} There is no undo, ` +
          `and no backup is taken — download one from the application's Storage tab first if you ` +
          `might want the data.`
        : `The entry is removed from the registry. Data already written on the worker is left ` +
          `where it is, reachable from the application's Storage tab.${inUse} An application ` +
          `still mounting this volume will fail to deploy.`,
      confirmLabel: withData ? 'Delete volume and data' : 'Remove entry',
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/volumes/${volume.id}${withData ? '?data=1' : ''}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (body.message) showToast('success', body.message);
        invalidateAll();
      } else {
        showToast('error', body.error || body.message || 'Failed to delete volume');
        // The row may be gone even when the data could not be removed, so the
        // table has to be refetched either way.
        invalidateAll();
      }
    } catch (e: any) {
      showToast('error', e.message || 'Failed to delete volume');
    }
  }

  function formatSize(bytes: number | null) {
    if (!bytes) return 'Unlimited';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }

</script>

<svelte:head>
  <title>Volumes - Rudder</title>
</svelte:head>

<div class="volumes-container">
  <PageHeader
    title="Volumes"
    subtitle="Manage persistent storage volumes for containers"
    back={{ href: '/dashboard', label: 'Back to Dashboard' }}
  >
    {#snippet actions()}
      <button onclick={() => showForm = !showForm} class="btn-primary btn-lg">
        {showForm ? 'Cancel' : '+ New Volume'}
      </button>
    {/snippet}
  </PageHeader>

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
            <label for="teamId">Team *</label>
            <!--
              No "No team" option: a volume with no owning team is invisible in
              this listing (which filters on membership) and reachable only by an
              admin, so offering it here produced a volume nobody could find. The
              API refuses one too.
            -->
            <select id="teamId" bind:value={formData.teamId} required>
              <option value="" disabled>Select a team…</option>
              {#each data.teams as team}
                <option value={team.id}>{team.name}</option>
              {/each}
            </select>
            {#if data.teams.length === 0}
              <p class="field-hint">
                A volume has to belong to a team. Create one first, or ask an admin to add you.
              </p>
            {/if}
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
          <button type="submit" disabled={isSubmitting} class="btn-primary btn-lg">
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
          <th>Used by</th>
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
            <!-- A registered volume only exists on disk once an application
                 mounts it, and it is namespaced per application — so this is
                 also what makes the usage figure attributable at all. -->
            <td class="text-muted">
              {#if volume.usedBy?.length}
                {volume.usedBy.join(', ')}
              {:else}
                <span title="No application references this entry, so no volume has been created for it.">unused</span>
              {/if}
            </td>
            <td class="text-muted mono">
              {volume.actualSizeMB != null ? `${volume.actualSizeMB} MB` : '—'}
              {volume.sizeLimit ? ` / ${formatSize(volume.sizeLimit)}` : ''}
            </td>
            <td class="text-muted">{formatDate(volume.createdAt)}</td>
            <td class="text-right actions-cell">
              <button onclick={() => deleteVolume(volume, false)} class="btn-sm"
                title="Remove the registry entry and leave the data on the worker">
                Remove entry
              </button>
              <button onclick={() => deleteVolume(volume, true)} class="btn-danger btn-sm"
                title="Remove the entry and delete the volume's data from the worker">
                Delete data
              </button>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="8" class="empty-message">
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

  .field-hint {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--text-secondary);
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

  .name-cell {
    font-weight: 500;
    color: var(--text-primary);
  }

  .path-cell {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-secondary);
  }

  .actions-cell { display: flex; gap: 6px; justify-content: flex-end; }

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
