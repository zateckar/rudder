<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { invalidateAll } from '$app/navigation';
  import { showToast } from '$lib/client/toast.svelte';
  import { confirmAction } from '$lib/client/dialog.svelte';

  let { data } = $props();

  let busy = $state<Record<string, boolean>>({});
  let showAddModal = $state(false);
  let addUsername = $state('');
  let addEmail = $state('');
  let addFullName = $state('');
  let addPassword = $state('');
  let addRole = $state('member');
  let addError = $state('');
  let adding = $state(false);

  let metricsInterval = $state(0);
  let savingInterval = $state(false);
  let intervalSaved = $state(false);
  let metricsRetentionDays = $state(30);
  let savingRetention = $state(false);
  let retentionSaved = $state(false);

  $effect(() => {
    metricsInterval = data.metricsInterval;
    metricsRetentionDays = data.metricsRetentionDays;
  });

  async function saveInterval() {
    savingInterval = true;
    intervalSaved = false;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics_interval_seconds: String(metricsInterval) }),
      });
      if (res.ok) {
        intervalSaved = true;
        setTimeout(() => intervalSaved = false, 2000);
      }
    } finally {
      savingInterval = false;
    }
  }

  async function saveRetention() {
    savingRetention = true;
    retentionSaved = false;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics_retention_days: String(metricsRetentionDays) }),
      });
      if (res.ok) {
        retentionSaved = true;
        setTimeout(() => retentionSaved = false, 2000);
      }
    } finally {
      savingRetention = false;
    }
  }

  async function toggleRole(userId: string, currentRole: string) {
    const newRole = currentRole === 'admin' ? 'member' : 'admin';
    const promoting = newRole === 'admin';
    const ok = await confirmAction({
      title: promoting ? 'Promote this user to admin?' : 'Demote this user to member?',
      body: promoting
        ? 'Admins see every team, every worker and the audit log, and can manage users.'
        : 'They will lose access to workers, users, settings and the audit log.',
      confirmLabel: promoting ? 'Promote' : 'Demote',
      danger: !promoting,
    });
    if (!ok) return;

    busy[userId] = true;
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        invalidateAll();
      } else {
        const err = await res.json();
        showToast('error', err.error || 'Failed to update role');
      }
    } finally {
      busy[userId] = false;
    }
  }

  async function deleteUser(userId: string) {
    const ok = await confirmAction({
      title: 'Delete this user?',
      body: 'This cannot be undone. Their audit log entries remain, attributed to the deleted account.',
      confirmLabel: 'Delete user',
      danger: true,
    });
    if (!ok) return;

    busy[userId] = true;
    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        invalidateAll();
      } else {
        const err = await res.json();
        showToast('error', err.error || 'Failed to delete user');
      }
    } finally {
      busy[userId] = false;
    }
  }

  async function addUser() {
    adding = true;
    addError = '';
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: addUsername,
          email: addEmail,
          fullName: addFullName,
          password: addPassword,
          role: addRole,
        }),
      });
      if (res.ok) {
        showAddModal = false;
        invalidateAll();
      } else {
        const err = await res.json();
        addError = err.error || 'Failed to create user';
      }
    } catch (e: any) {
      addError = e.message;
    } finally {
      adding = false;
    }
  }
</script>

<PageHeader title="Admin">
  {#snippet actions()}
    <button class="btn-primary" onclick={() => { addUsername = ''; addEmail = ''; addFullName = ''; addPassword = ''; addRole = 'member'; addError = ''; showAddModal = true; }} title="Create a new user account">
      + Add User
    </button>
  {/snippet}
</PageHeader>

<div class="card">
  <table class="data-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Email</th>
        <th>Role</th>
        <th>Joined</th>
        <th class="text-right">Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each data.usersList as user (user.id)}
        <tr>
          <td>
            <div class="user-name">{user.fullName}</div>
            <div class="user-handle">@{user.username}</div>
          </td>
          <td class="text-secondary">{user.email}</td>
          <td>
            <span class="role-badge {user.role}">{user.role}</span>
          </td>
          <td class="text-secondary">{new Date(user.createdAt).toLocaleDateString()}</td>
          <td class="text-right">
            {#if user.id === data.user.id}
              <span class="text-muted">you</span>
            {:else}
              <button
                class="btn-tiny {user.role === 'admin' ? 'btn-demote' : 'btn-promote'}"
                disabled={busy[user.id]}
                onclick={() => toggleRole(user.id, user.role)}
                title="{user.role === 'admin' ? 'Demote to member' : 'Promote to admin'}"
              >
                {user.role === 'admin' ? 'Demote' : 'Make Admin'}
              </button>
              <button
                class="btn-tiny btn-delete"
                disabled={busy[user.id]}
                onclick={() => deleteUser(user.id)}
                title="Permanently delete this user"
              >
                Delete
              </button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<!-- ── Settings ────────────────────────────────────────────────────── -->
<div class="settings-section">
  <h2 class="section-title">Settings</h2>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Metrics collection interval</span>
      <span class="setting-hint">How often worker and container metrics are collected</span>
    </div>
    <div class="setting-control">
      <select bind:value={metricsInterval}>
        <option value={30}>30 seconds</option>
        <option value={60}>1 minute</option>
        <option value={120}>2 minutes</option>
        <option value={300}>5 minutes</option>
        <option value={600}>10 minutes</option>
        <option value={900}>15 minutes</option>
        <option value={1800}>30 minutes</option>
      </select>
      <button class="btn-tiny btn-save" disabled={savingInterval} onclick={saveInterval} title="Save the metrics collection interval">
        {savingInterval ? '…' : intervalSaved ? '✓' : 'Save'}
      </button>
    </div>
  </div>
  <div class="setting-row">
    <div class="setting-info">
      <span class="setting-label">Data retention</span>
      <span class="setting-hint">Metrics and pings older than this are automatically pruned. Data 7+ days old is down-sampled to 1 row/hour.</span>
    </div>
    <div class="setting-control">
      <select bind:value={metricsRetentionDays}>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
        <option value={60}>60 days</option>
        <option value={90}>90 days</option>
      </select>
      <button class="btn-tiny btn-save" disabled={savingRetention} onclick={saveRetention} title="Save the data retention period">
        {savingRetention ? '…' : retentionSaved ? '✓' : 'Save'}
      </button>
    </div>
  </div>
</div>

<!-- ── Add User modal ─────────────────────────────────────────────── -->
<Modal bind:open={showAddModal} title="Add User">
  {#if addError}
    <div class="modal-error">{addError}</div>
  {/if}
  <div class="form-group">
    <label for="addUsername">Username</label>
    <input type="text" id="addUsername" bind:value={addUsername} placeholder="jdoe" required />
  </div>
  <div class="form-group">
    <label for="addEmail">Email</label>
    <input type="email" id="addEmail" bind:value={addEmail} placeholder="jdoe@example.com" required />
  </div>
  <div class="form-group">
    <label for="addFullName">Full Name</label>
    <input type="text" id="addFullName" bind:value={addFullName} placeholder="Jane Doe" required />
  </div>
  <div class="form-group">
    <label for="addPassword">Password</label>
    <input type="password" id="addPassword" bind:value={addPassword} placeholder="Min 8 characters" required minlength="8" />
  </div>
  <div class="form-group">
    <label for="addRole">Role</label>
    <select id="addRole" bind:value={addRole}>
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </select>
  </div>
  <div class="modal-actions">
    <button class="btn-secondary" onclick={() => showAddModal = false} title="Close without creating user">Cancel</button>
    <button
      class="btn-primary"
      disabled={adding || !addUsername || !addEmail || !addFullName || !addPassword}
      onclick={addUser}
      title="Create the new user account"
    >
      {adding ? 'Creating…' : 'Create User'}
    </button>
  </div>
</Modal>

<style>
  .card {
    background: var(--bg-raised);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .settings-section {
    margin-top: 24px;
    background: var(--bg-raised);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    padding: 20px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 16px;
  }

  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
  }

  .setting-info { display: flex; flex-direction: column; gap: 2px; }
  .setting-label { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .setting-hint { font-size: 12px; color: var(--text-muted); }

  .setting-control { display: flex; align-items: center; gap: 8px; }

  .setting-control select {
    padding: 6px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-input);
    color: var(--text-primary);
  }

  .btn-save {
    color: var(--accent-text) !important;
    border-color: var(--border-default) !important;
    background: var(--accent-subtle) !important;
  }

  .setting-row + .setting-row {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }

  .text-secondary { color: var(--text-secondary); }

  .data-table th {
    padding: 10px 16px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border-subtle);
  }

  .user-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .user-handle {
    font-size: 12px;
    color: var(--text-muted);
  }

  .role-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .role-badge.admin {
    background: var(--purple-subtle);
    color: var(--purple);
  }

  .role-badge.member {
    background: var(--bg-overlay);
    color: var(--text-muted);
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
    margin-left: 6px;
  }

  .btn-tiny:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .btn-tiny:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-promote {
    color: var(--accent-text);
    border-color: var(--border-default);
    background: var(--accent-subtle);
  }

  .btn-promote:hover:not(:disabled) {
    background: var(--bg-active);
  }

  .btn-demote {
    color: var(--yellow-text);
    border-color: var(--border-default);
    background: var(--yellow-subtle);
  }

  .btn-demote:hover:not(:disabled) {
    background: var(--bg-active);
  }

  .btn-delete {
    color: var(--red-text);
    border-color: var(--border-default);
    background: var(--red-subtle);
  }

  .btn-delete:hover:not(:disabled) {
    background: var(--bg-active);
  }

  /* ── Modal ────────────────────────────────────── */

  .modal-error {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: 13px;
    margin-bottom: 12px;
  }

  .form-group input::placeholder,
  .form-group select::placeholder {
    color: var(--text-muted);
  }

  .form-group input:focus,
  .form-group select:focus {
    background: var(--bg-raised);
  }
</style>
