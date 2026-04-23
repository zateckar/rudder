<script lang="ts">
  import { onMount } from 'svelte';
  
  let { data } = $props();
  let secretsList = $state<any[]>([]);
  let loading = $state(true);
  let showForm = $state(false);
  let editing = $state<any>(null);
  let saving = $state(false);
  let error = $state('');
  let showValues = $state<Record<string, boolean>>({});

  let fName = $state('');
  let fValue = $state('');
  let fDesc = $state('');
  let fScope = $state<'global' | 'team'>('team');
  let fTeamId = $state('');

  let isAdmin = $derived(data.user?.role === 'admin');

  onMount(() => loadSecrets());

  async function loadSecrets() {
    loading = true;
    try {
      const res = await fetch('/api/secrets');
      if (res.ok) secretsList = await res.json();
    } finally { loading = false; }
  }

  function resetForm() {
    fName = ''; fValue = ''; fDesc = ''; fScope = 'team'; fTeamId = '';
    editing = null; showForm = false; error = '';
  }

  function startEdit(s: any) {
    editing = s;
    fName = s.name; fValue = s.value; fDesc = s.description || '';
    fScope = s.scope; fTeamId = s.teamId || '';
    showForm = true; error = '';
  }

  async function saveSecret() {
    if (!fName || !fValue) { error = 'Name and value are required'; return; }
    saving = true; error = '';
    try {
      if (editing) {
        const res = await fetch('/api/secrets', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editing.id, name: fName, value: fValue, description: fDesc }),
        });
        if (!res.ok) { const b = await res.json(); error = b.error || 'Failed'; }
      } else {
        const res = await fetch('/api/secrets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fName, value: fValue, description: fDesc, scope: fScope, teamId: fTeamId || undefined }),
        });
        if (!res.ok) { const b = await res.json(); error = b.error || 'Failed'; }
      }
      resetForm();
      loadSecrets();
    } catch (e: any) { error = e.message; }
    finally { saving = false; }
  }

  async function deleteSecret(id: string) {
    if (!confirm('Delete this secret? Containers using it will fail.')) return;
    const res = await fetch(`/api/secrets?id=${id}`, { method: 'DELETE' });
    if (res.ok) { secretsList = secretsList.filter(s => s.id !== id); }
    else { const b = await res.json(); alert(b.error || 'Failed'); }
  }

  function toggleValue(id: string) { showValues[id] = !showValues[id]; }

  function maskValue(v: string): string {
    if (!v) return '—';
    return '•'.repeat(Math.min(v.length, 20));
  }
</script>

<header>
  <h1>Secrets</h1>
  <button class="btn-primary" onclick={() => { resetForm(); showForm = true; fScope = isAdmin ? 'global' : 'team'; }}>
    + New Secret
  </button>
</header>

<p class="page-desc">
  Environment variables available to containers. <b>Global</b> secrets are available to all users.
  <b>Team</b> secrets are available only to members of that team.
</p>

{#if showForm}
  <div class="form-card">
    <h3>{editing ? 'Edit Secret' : 'New Secret'}</h3>
    {#if error}<div class="form-error">{error}</div>{/if}
    <div class="form-row">
      <div class="form-group">
        <label for="secret-name">Name</label>
        <input id="secret-name" type="text" bind:value={fName} placeholder="e.g. DATABASE_URL" />
        <span class="hint">Used as environment variable name. Uppercase with underscores recommended.</span>
      </div>
      <div class="form-group">
        <label for="secret-value">Value</label>
        <input id="secret-value" type="text" bind:value={fValue} placeholder="e.g. postgres://user:pass@host/db" />
        <span class="hint">The secret value. Stored encrypted.</span>
      </div>
    </div>
    <div class="form-group">
      <label for="secret-desc">Description</label>
      <input id="secret-desc" type="text" bind:value={fDesc} placeholder="e.g. Main database connection string" />
    </div>
    {#if !editing}
      <div class="form-row">
        <div class="form-group">
          <label for="secret-scope">Scope</label>
          <select id="secret-scope" bind:value={fScope}>
            {#if isAdmin}<option value="global">Global (all users)</option>{/if}
            <option value="team">Team only</option>
          </select>
        </div>
        {#if fScope === 'team'}
          <div class="form-group">
            <label for="secret-team-id">Team ID (optional)</label>
            <input id="secret-team-id" type="text" bind:value={fTeamId} placeholder="Leave empty for unassigned" />
          </div>
        {/if}
      </div>
    {/if}
    <div class="form-actions">
      <button class="btn-secondary" onclick={resetForm}>Cancel</button>
      <button class="btn-primary" onclick={saveSecret} disabled={saving || !fName || !fValue}>
        {saving ? 'Saving…' : editing ? 'Update' : 'Create'}
      </button>
    </div>
  </div>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if secretsList.length === 0}
  <div class="empty">
    <p>No secrets yet.</p>
    <p class="muted small">Secrets are injected as environment variables into your containers at deploy time.</p>
  </div>
{:else}
  <div class="secrets-table">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Value</th>
          <th>Scope</th>
          <th>Description</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each secretsList as s}
          <tr>
            <td class="name-cell"><code>{s.name}</code></td>
            <td class="value-cell">
              <span class="val">{showValues[s.id] ? s.value : maskValue(s.value)}</span>
              <button class="btn-icon" onclick={() => toggleValue(s.id)} title={showValues[s.id] ? 'Hide' : 'Show'}>
                {showValues[s.id] ? 'Hide' : 'Show'}
              </button>
            </td>
            <td><span class="badge {s.scope}">{s.scope}</span></td>
            <td class="muted">{s.description || '—'}</td>
            <td class="muted">{new Date(s.updatedAt).toLocaleDateString()}</td>
            <td class="actions">
              <button class="btn-icon" onclick={() => startEdit(s)} title="Edit">Edit</button>
              <button class="btn-icon danger" onclick={() => deleteSecret(s.id)} title="Delete">Del</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<div class="usage-guide">
  <h3>How to use secrets</h3>
  <p>Secrets are available to containers as environment variables. Reference them by name in your application configuration:</p>

  <div class="example">
    <span class="example-label">Docker / Podman Compose</span>
<pre>services:
  app:
    environment:
      - DATABASE_URL    # resolved from secrets store
      - API_KEY         # resolved from secrets store</pre>
  </div>

  <div class="example">
    <span class="example-label">Podman CLI</span>
<pre>podman run --env DATABASE_URL --env API_KEY myapp:latest</pre>
  </div>

  <div class="example">
    <span class="example-label">Application code</span>
<pre>const dbUrl = process.env.DATABASE_URL;
const apiKey = process.env.API_KEY;</pre>
  </div>

  <p class="muted small">
    Global secrets are injected for all deployments. Team secrets are injected only for applications belonging to that team.
    Secret values are encrypted at rest and decrypted only when needed for container deployment.
  </p>
</div>

<style>
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  header h1 { font-size: 26px; font-weight: 700; color: var(--text-primary); margin: 0; }

  .page-desc { font-size: 13px; color: var(--text-muted); margin: 0 0 20px; max-width: 600px; line-height: 1.5; }

  .muted { color: var(--text-muted); }
  .small { font-size: 12px; }

  /* Table */
  .secrets-table { overflow-x: auto; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; padding: 8px 10px; font-size: 10px; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
    background: var(--bg-overlay); border-bottom: 1px solid var(--border-default);
  }
  td { padding: 10px; border-top: 1px solid var(--border-subtle); }
  tr:hover td { background: var(--bg-hover); }

  .name-cell code { font-family: var(--font-mono); font-size: 13px; color: var(--accent-text); }
  .value-cell { display: flex; align-items: center; gap: 6px; }
  .val { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 4px; }

  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .badge.global { background: var(--accent-subtle); color: var(--accent-text); }
  .badge.team { background: var(--bg-overlay); color: var(--text-muted); }

  .btn-icon {
    padding: 3px 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    font-size: 11px; background: var(--bg-overlay); color: var(--text-muted); cursor: pointer;
  }
  .btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-icon.danger { color: var(--red-text); }
  .btn-icon.danger:hover { background: var(--red-subtle); }

  /* Form */
  .form-card {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 18px; margin-bottom: 20px;
  }
  .form-card h3 { font-size: 14px; font-weight: 600; margin: 0 0 14px; color: var(--text-primary); }
  .form-error { background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red); padding: 8px 12px; border-radius: var(--radius-sm); margin-bottom: 12px; font-size: 13px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .form-group { margin-bottom: 12px; }
  .form-group label { display: block; margin-bottom: 4px; font-size: 12px; font-weight: 500; color: var(--text-secondary); }
  .form-group input, .form-group select {
    width: 100%; padding: 8px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    font-size: 13px; background: var(--bg-input); color: var(--text-primary); box-sizing: border-box;
  }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--border-focus); }
  .hint { display: block; font-size: 11px; color: var(--text-muted); margin-top: 3px; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }

  .btn-primary {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    background: var(--accent); color: var(--text-inverse); border: none; cursor: pointer;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    background: var(--bg-raised); color: var(--text-secondary); border: 1px solid var(--border-default); cursor: pointer;
  }
  .btn-secondary:hover { background: var(--bg-hover); }

  .empty { text-align: center; padding: 24px; }
  .empty p { color: var(--text-secondary); margin: 4px 0; }

  /* Usage guide */
  .usage-guide { border-top: 1px solid var(--border-subtle); padding-top: 20px; margin-top: 8px; }
  .usage-guide h3 { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0 0 8px; }
  .usage-guide p { font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin: 8px 0; }

  .example { margin: 12px 0; }
  .example-label { display: block; font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .example pre {
    background: var(--bg-root); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 12px 16px; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);
    overflow-x: auto; margin: 0; line-height: 1.6;
  }
</style>
