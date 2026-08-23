<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { invalidateAll } from '$app/navigation';

  let { data } = $props();
  let showCreateForm = $state(false);
  let creating = $state(false);
  let teams = $state<any[]>([]);
  let toast = $state<{ type: 'success' | 'error'; message: string } | null>(null);

  $effect(() => {
    teams = data.teams ?? [];
  });

  function showMsg(type: 'success' | 'error', message: string) {
    toast = { type, message };
    setTimeout(() => (toast = null), 3500);
  }
</script>

{#if toast}
  <div class="toast {toast.type}">{toast.message}</div>
{/if}

<PageHeader title="Teams">
  {#snippet actions()}
    {#if data.user?.role === 'admin'}
      <button class="btn-primary" onclick={() => (showCreateForm = !showCreateForm)}>
        {showCreateForm ? 'Cancel' : 'Create Team'}
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if showCreateForm}
  <div class="create-form">
    <form
      onsubmit={async (e) => {
        e.preventDefault();
        creating = true;
        const fd = new FormData(e.currentTarget as HTMLFormElement);
        const name = fd.get('name')?.toString();
        try {
          const res = await fetch('/api/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          const body = await res.json();
          if (res.ok) {
            showCreateForm = false;
            showMsg('success', 'Team created');
            invalidateAll();
          } else {
            showMsg('error', body.error || 'Failed to create team');
          }
        } catch (err: any) {
          showMsg('error', err.message);
        } finally {
          creating = false;
        }
      }}
    >
      <div class="form-group">
        <label for="name">Team Name</label>
        <input type="text" id="name" name="name" placeholder="e.g., Engineering" required />
      </div>
      <div class="form-actions">
        <button type="submit" class="btn-primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create Team'}
        </button>
      </div>
    </form>
  </div>
{/if}

<div class="teams-list">
  {#if teams.length === 0}
    <div class="empty-state">
      <p>No teams yet.{data.user?.role === 'admin' ? ' Create your first team to get started.' : ' Ask an admin to add you to a team.'}</p>
    </div>
  {:else}
    <div class="teams-grid">
      {#each teams as team}
        <div class="team-card">
          <div class="team-header">
            <h3>{team.name}</h3>
            <span class="slug">{team.slug}</span>
          </div>
          <div class="team-meta">
            <p>{team.memberCount ?? 0} member{team.memberCount !== 1 ? 's' : ''}</p>
          </div>
          <div class="team-actions">
            <a href="/teams/{team.id}" class="btn-small">View</a>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .toast {
    position: fixed; top: 20px; right: 20px; padding: 12px 20px;
    border-radius: var(--radius-lg); font-size: 14px; font-weight: 500; z-index: 2000;
    animation: slide-in 0.2s ease;
  }
  .toast.success {
    background: var(--green-subtle); color: var(--green-text); border: 1px solid var(--green);
  }
  .toast.error {
    background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red);
  }
  @keyframes slide-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  .create-form {
    background: var(--bg-raised); padding: 24px; border-radius: var(--radius-lg);
    margin-bottom: 24px; border: 1px solid var(--border-subtle);
  }
  /* Inside the create-team card, so no separator above the buttons. */
  .form-actions {
    margin-top: 20px;
  }

  .teams-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px;
  }
  .team-card {
    background: var(--bg-raised); padding: 20px; border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle); transition: border-color 0.15s, background 0.15s;
  }
  .team-card:hover {
    border-color: var(--border-default); background: var(--bg-hover);
  }
  .team-header {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
  }
  .team-header h3 { font-size: 18px; color: var(--text-primary); }
  .slug {
    font-size: 12px; color: var(--text-secondary); background: var(--bg-overlay);
    padding: 2px 8px; border-radius: 100px; font-family: var(--font-mono);
  }
  .team-meta { font-size: 14px; color: var(--text-secondary); margin-bottom: 16px; }
  .team-actions { padding-top: 16px; border-top: 1px solid var(--border-subtle); }
  .btn-small {
    padding: 6px 12px; background: var(--bg-overlay); border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn-small:hover { background: var(--bg-hover); border-color: var(--border-strong); }
</style>
