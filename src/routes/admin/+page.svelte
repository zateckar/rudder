<script lang="ts">
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

  let sshKeys = $state<any[]>([]);
  let showSshForm = $state(false);

  $effect(() => {
    metricsInterval = data.metricsInterval;
    sshKeys = data.sshKeys || [];
  });
  let sshCreating = $state(false);
  let sshError = $state('');

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

  async function toggleRole(userId: string, currentRole: string) {
    const newRole = currentRole === 'admin' ? 'member' : 'admin';
    if (!confirm(`${newRole === 'admin' ? 'Promote' : 'Demote'} this user to ${newRole}?`)) return;

    busy[userId] = true;
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to update role');
      }
    } finally {
      busy[userId] = false;
    }
  }

  async function deleteUser(userId: string) {
    if (!confirm('Delete this user? This cannot be undone.')) return;

    busy[userId] = true;
    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to delete user');
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
        window.location.reload();
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

  async function createSshKey() {
    const nameInput = document.getElementById('sshKeyName') as HTMLInputElement;
    const keyInput = document.getElementById('sshPrivateKey') as HTMLTextAreaElement;
    if (!nameInput?.value || !keyInput?.value) return;
    sshCreating = true;
    sshError = '';
    try {
      const res = await fetch('/api/ssh-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, privateKey: keyInput.value }),
      });
      const body = await res.json();
      if (res.ok) {
        showSshForm = false;
        sshKeys = [...sshKeys, body];
      } else {
        sshError = body.error || 'Failed to add key';
      }
    } catch (e: any) {
      sshError = e.message;
    } finally {
      sshCreating = false;
    }
  }

  async function deleteSshKey(id: string) {
    if (!confirm('Delete this SSH key?')) return;
    const res = await fetch(`/api/ssh-keys?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      sshKeys = sshKeys.filter(k => k.id !== id);
    } else {
      const body = await res.json();
      alert(body.error || 'Failed to delete');
    }
  }
</script>

<header>
  <h1>Admin</h1>
  <button class="btn-primary" onclick={() => { addUsername = ''; addEmail = ''; addFullName = ''; addPassword = ''; addRole = 'member'; addError = ''; showAddModal = true; }} title="Create a new user account">
    + Add User
  </button>
</header>

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
      <span class="setting-hint">Metrics and pings older than this are automatically pruned</span>
    </div>
    <div class="setting-control">
      <span class="text-muted">30 days</span>
    </div>
  </div>
</div>

<!-- ── SSH Keys ────────────────────────────────────────────────────── -->
<div class="settings-section">
  <div class="ssh-header">
    <h2 class="section-title" style="margin-bottom:0">SSH Keys</h2>
    <button class="btn-tiny" onclick={() => { showSshForm = !showSshForm; sshError = ''; }}>
      {showSshForm ? 'Cancel' : '+ Add Key'}
    </button>
  </div>
  <p class="ssh-desc">Used to connect to worker nodes for provisioning and remote management.</p>

  {#if sshError}
    <div class="ssh-error">{sshError}</div>
  {/if}

  {#if showSshForm}
    <div class="ssh-form">
      <div class="form-group">
        <label for="sshKeyName">Key Name</label>
        <input type="text" id="sshKeyName" placeholder="e.g., production-workers" />
      </div>
      <div class="form-group">
        <label for="sshPrivateKey">Private Key (PEM)</label>
        <textarea id="sshPrivateKey" rows="6" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"></textarea>
        <span class="form-hint">Paste the full PEM private key. The public key is derived automatically.</span>
      </div>
      <button class="btn-primary" disabled={sshCreating} onclick={createSshKey}>
        {sshCreating ? 'Adding…' : 'Add SSH Key'}
      </button>
    </div>
  {/if}

  {#if sshKeys.length === 0}
    <p class="text-muted" style="padding:12px 0">No SSH keys yet.</p>
  {:else}
    <div class="ssh-keys-list">
      {#each sshKeys as key}
        <div class="ssh-key-row">
          <div class="ssh-key-info">
            <span class="ssh-key-name">{key.name}</span>
            <span class="ssh-key-meta mono">{key.publicKey?.substring(0, 50)}…</span>
            <span class="ssh-key-meta">Added {new Date(key.createdAt).toLocaleDateString()}</span>
          </div>
          <button class="btn-tiny btn-delete" onclick={() => deleteSshKey(key.id)}>Delete</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- ── Add User modal ─────────────────────────────────────────────── -->
{#if showAddModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showAddModal = false} onkeydown={(e) => e.key === 'Escape' && (showAddModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Add User</h3>
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
    </div>
  </div>
{/if}

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }

  header h1 {
    font-size: 26px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .btn-primary {
    padding: 9px 18px;
    background: var(--accent);
    color: var(--text-inverse);
    border-radius: var(--radius-md);
    font-weight: 600;
    font-size: 13px;
    text-decoration: none;
    border: none;
    cursor: pointer;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: 9px 18px;
    background: var(--bg-raised);
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: 13px;
    cursor: pointer;
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

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

  .text-muted { color: var(--text-muted); }
  .text-secondary { color: var(--text-secondary); }

  .data-table {
    width: 100%;
    border-collapse: collapse;
  }

  .data-table thead {
    background: var(--bg-overlay);
  }

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

  .data-table td {
    padding: 14px 16px;
    border-top: 1px solid var(--border-subtle);
    font-size: 14px;
    color: var(--text-primary);
  }

  .data-table tr:hover {
    background: var(--bg-hover);
  }

  .user-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .user-handle {
    font-size: 12px;
    color: var(--text-muted);
  }

  .text-right {
    text-align: right;
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

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-surface);
    padding: 28px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-default);
    width: 100%;
    max-width: 420px;
    box-shadow: var(--shadow-md);
  }

  .modal h3 {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .modal-error {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: 13px;
    margin-bottom: 12px;
  }

  .form-group {
    margin-bottom: 14px;
  }

  .form-group label {
    display: block;
    margin-bottom: 5px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
  }

  .form-group input::placeholder,
  .form-group select::placeholder {
    color: var(--text-muted);
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--border-focus);
    background: var(--bg-raised);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }

  /* ── SSH Keys ──────────────────────────────────── */

  .ssh-header {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;
  }
  .ssh-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 14px; }

  .ssh-form {
    background: var(--bg-overlay); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 16px; margin-bottom: 14px;
  }

  .ssh-form textarea {
    width: 100%; padding: 9px 12px; border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); font-size: 13px; font-family: var(--font-mono);
    background: var(--bg-input); color: var(--text-primary); box-sizing: border-box; resize: vertical;
  }
  .ssh-form textarea:focus { outline: none; border-color: var(--border-focus); }

  .ssh-error {
    background: var(--red-subtle); border: 1px solid var(--red); color: var(--red-text);
    padding: 8px 12px; border-radius: var(--radius-sm); margin-bottom: 14px; font-size: 13px;
  }

  .ssh-keys-list { display: flex; flex-direction: column; }
  .ssh-key-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 0; border-bottom: 1px solid var(--border-subtle);
  }
  .ssh-key-row:last-child { border-bottom: none; }
  .ssh-key-info { display: flex; flex-direction: column; gap: 2px; }
  .ssh-key-name { font-weight: 500; font-size: 14px; color: var(--text-primary); }
  .ssh-key-meta { font-size: 12px; color: var(--text-muted); }
  .ssh-key-meta.mono { font-family: var(--font-mono); }
  .mono { font-family: var(--font-mono); }

  .form-hint { display: block; font-size: 11px; color: var(--text-muted); margin-top: 4px; }
</style>
