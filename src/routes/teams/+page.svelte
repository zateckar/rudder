<script lang="ts">
  import { enhance } from '$app/forms';

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

<header>
  <h1>Teams</h1>
  {#if data.user?.role === 'admin'}
    <button class="btn-primary" onclick={() => (showCreateForm = !showCreateForm)}>
      {showCreateForm ? 'Cancel' : 'Create Team'}
    </button>
  {/if}
</header>

{#if showCreateForm}
  <div class="create-form">
    <form
      method="POST"
      action="/api/teams"
      use:enhance={() => {
        creating = true;
        return async ({ result, update }) => {
          creating = false;
          showCreateForm = false;
          if (result.type === 'error' || (result as any).status >= 400) {
            showMsg('error', 'Failed to create team');
          } else {
            showMsg('success', 'Team created');
            await update();
            // Reload teams from server data after form submission
            window.location.reload();
          }
        };
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

  header {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;
  }
  header h1 { font-size: 28px; color: var(--text-primary); }

  .btn-primary {
    padding: 10px 20px; background: var(--accent); color: var(--text-inverse);
    border-radius: var(--radius-md); font-weight: 500; border: none; cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

  .create-form {
    background: var(--bg-raised); padding: 24px; border-radius: var(--radius-lg);
    margin-bottom: 24px; border: 1px solid var(--border-subtle);
  }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; margin-bottom: 6px; font-weight: 500; color: var(--text-secondary); }
  .form-group input {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); font-size: 14px; box-sizing: border-box;
    background: var(--bg-input); color: var(--text-primary); transition: border-color 0.15s, box-shadow 0.15s;
  }
  .form-group input:focus {
    outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-subtle);
  }
  .form-actions { margin-top: 20px; }

  .empty-state {
    background: var(--bg-raised); padding: 60px; border-radius: var(--radius-lg);
    text-align: center; color: var(--text-secondary); border: 1px solid var(--border-subtle);
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
