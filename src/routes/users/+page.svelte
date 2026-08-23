<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { invalidateAll } from '$app/navigation';
  import { showToast } from '$lib/client/toast.svelte';
  import { confirmAction } from '$lib/client/dialog.svelte';

  let { data } = $props();

  /**
   * "today" / "3 days ago" / a date. Last access is answered in orders of
   * magnitude — an account used this week versus one dormant since March — and an
   * exact timestamp reads as more precision than a five-minute throttle has.
   * The full value is in the cell's title.
   */
  function relativeDay(at: string | Date): string {
    const then = new Date(at);
    const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return then.toLocaleDateString();
  }

  let busy = $state<Record<string, boolean>>({});
  let showAddModal = $state(false);
  let addUsername = $state('');
  let addEmail = $state('');
  let addFullName = $state('');
  let addPassword = $state('');
  let addRole = $state('member');
  let addError = $state('');
  let adding = $state(false);

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

  // ── Team membership ─────────────────────────────────────────────
  //
  // Moved here from the team detail page. Membership is an attribute of an
  // account — and for OIDC accounts it is written by the claim sync — so the
  // place to see and change it is next to the account, not spread over one page
  // per team where nobody can see who is in what.

  let showMembership = $state(false);
  let membershipUser = $state<any>(null);
  let membershipBusy = $state(false);
  let membershipError = $state('');
  let addTeamId = $state('');

  const currentUserRow = $derived(
    membershipUser ? data.usersList.find((u) => u.id === membershipUser.id) : null,
  );
  const joinableTeams = $derived(
    data.teams.filter((t) => !(currentUserRow?.teams ?? []).some((m) => m.teamId === t.id)),
  );

  function openMembership(user: any) {
    membershipUser = user;
    membershipError = '';
    addTeamId = '';
    showMembership = true;
  }

  async function membershipRequest(url: string, init: RequestInit): Promise<boolean> {
    membershipBusy = true;
    membershipError = '';
    try {
      const res = await fetch(url, init);
      if (res.ok) {
        await invalidateAll();
        return true;
      }
      membershipError = (await res.json()).error || 'Request failed';
      return false;
    } catch (e: any) {
      membershipError = e.message;
      return false;
    } finally {
      membershipBusy = false;
    }
  }

  async function addToTeam() {
    if (!addTeamId) return;
    const ok = await membershipRequest(`/api/teams/${addTeamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: membershipUser.id }),
    });
    if (ok) addTeamId = '';
  }

  async function removeFromTeam(team: { teamId: string; teamName: string }) {
    const ok = await confirmAction({
      title: `Remove ${membershipUser.fullName} from ${team.teamName}?`,
      body: 'They lose access to the team’s applications, secrets and volumes. Their account is not deleted.',
      confirmLabel: 'Remove from team',
      danger: true,
    });
    if (!ok) return;

    await membershipRequest(`/api/teams/${team.teamId}/members?memberId=${membershipUser.id}`, {
      method: 'DELETE',
    });
  }

  // ── Password reset ──────────────────────────────────────────────

  let showPasswordModal = $state(false);
  let passwordUser = $state<any>(null);
  let newPassword = $state('');
  let confirmPassword = $state('');
  let passwordError = $state('');
  let resetting = $state(false);

  function openPasswordReset(user: any) {
    passwordUser = user;
    newPassword = '';
    confirmPassword = '';
    passwordError = '';
    showPasswordModal = true;
  }

  async function resetPassword() {
    if (newPassword !== confirmPassword) {
      passwordError = 'The two passwords do not match';
      return;
    }

    resetting = true;
    passwordError = '';
    try {
      const res = await fetch(`/api/users/${passwordUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      if (res.ok) {
        showPasswordModal = false;
        // Every session minted under the old password is revoked server-side, so
        // say so — the user being reset is about to be signed out everywhere.
        showToast('success', `Password set for ${passwordUser.username}. Their sessions were revoked.`);
        invalidateAll();
      } else {
        passwordError = (await res.json()).error || 'Failed to set the password';
      }
    } catch (e: any) {
      passwordError = e.message;
    } finally {
      resetting = false;
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

<PageHeader title="Users" subtitle="Accounts that can sign in to Rudder, and what they are allowed to do.">
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
        <th>Sign-in</th>
        <th>Teams</th>
        <th>Role</th>
        <th>Joined</th>
        <th>Last access</th>
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
            <!-- Both, for an account that has a password and an IdP link. -->
            {#if user.isOidc}
              <span class="source-badge oidc" title="Signs in through the identity provider">OIDC</span>
            {/if}
            {#if user.isLocal}
              <span class="source-badge local" title="Signs in with a password held by Rudder">Local</span>
            {/if}
            {#if !user.isOidc && !user.isLocal}
              <span class="text-muted" title="No password and no identity-provider link — this account cannot sign in">no sign-in</span>
            {/if}
            {#if user.isOidc && user.lastSyncedAt}
              <div class="synced">synced {new Date(user.lastSyncedAt).toLocaleDateString()}</div>
            {/if}
          </td>
          <td>
            <div class="team-chips">
              {#each user.teams as team (team.teamId)}
                <a class="team-chip" href="/teams/{team.teamId}" title="Member of {team.teamName}">
                  {team.teamName}
                </a>
              {:else}
                <span class="text-muted">—</span>
              {/each}
              <button
                class="team-chip manage"
                onclick={() => openMembership(user)}
                title="Add {user.fullName} to a team, or remove them from one"
              >
                Manage
              </button>
            </div>
          </td>
          <td>
            <span class="role-badge {user.role}">{user.role}</span>
          </td>
          <td class="text-secondary">{new Date(user.createdAt).toLocaleDateString()}</td>
          <td class="text-secondary">
            {#if user.lastSeenAt}
              <span title={new Date(user.lastSeenAt).toLocaleString()}>{relativeDay(user.lastSeenAt)}</span>
            {:else}
              <span class="text-muted" title="No request from this account since Rudder started recording">never</span>
            {/if}
          </td>
          <td class="text-right">
            <button
              class="btn-tiny"
              disabled={busy[user.id]}
              onclick={() => openPasswordReset(user)}
              title="Set a new password for {user.username}"
            >
              Password
            </button>
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

<!-- ── Team membership modal ──────────────────────────────────────── -->
<Modal
  bind:open={showMembership}
  title="Teams for {membershipUser?.fullName ?? ''}"
  maxWidth="520px"
  onclose={() => (membershipUser = null)}
>
  {#if membershipError}
    <div class="modal-error">{membershipError}</div>
  {/if}

  {#if membershipUser?.isOidc}
    <p class="modal-note">
      This account signs in through the identity provider. If a team claim is configured, its
      memberships are rewritten from the claim at every login — so a team added here lasts only until
      then. To grant lasting access, put it in the claim.
    </p>
  {/if}

  <div class="membership-list">
    {#each currentUserRow?.teams ?? [] as team (team.teamId)}
      <div class="membership-row">
        <a class="membership-name" href="/teams/{team.teamId}">{team.teamName}</a>
        <button
          class="btn-tiny btn-delete"
          disabled={membershipBusy}
          onclick={() => removeFromTeam(team)}
          title="Remove from {team.teamName}"
        >
          Remove
        </button>
      </div>
    {:else}
      <p class="modal-note">In no teams yet.</p>
    {/each}
  </div>

  {#if joinableTeams.length > 0}
    <div class="membership-add">
      <div class="form-group">
        <label for="addTeamId">Add to team</label>
        <select id="addTeamId" bind:value={addTeamId}>
          <option value="">Choose a team…</option>
          {#each joinableTeams as team (team.id)}
            <option value={team.id}>{team.name}</option>
          {/each}
        </select>
      </div>
      <button
        class="btn-primary"
        disabled={membershipBusy || !addTeamId}
        onclick={addToTeam}
        title="Add this user to the selected team"
      >
        {membershipBusy ? 'Working…' : 'Add'}
      </button>
    </div>
  {:else if data.teams.length > 0}
    <p class="modal-note">Already in every team.</p>
  {/if}

  <div class="modal-actions">
    <button class="btn-secondary" onclick={() => (showMembership = false)} title="Close">Done</button>
  </div>
</Modal>

<!-- ── Password reset modal ───────────────────────────────────────── -->
<Modal
  bind:open={showPasswordModal}
  title="Set a password for {passwordUser?.username ?? ''}"
  onclose={() => { passwordUser = null; newPassword = ''; confirmPassword = ''; }}
>
  {#if passwordError}
    <div class="modal-error">{passwordError}</div>
  {/if}

  <p class="modal-note">
    {#if passwordUser?.id === data.user.id}
      This is your own account. Every session is revoked, including this one — you will be signed
      out and will have to log back in with the new password.
    {:else}
      Every session this account has open is revoked, so they are signed out everywhere and will
      need the new password.
    {/if}
    {#if passwordUser && !passwordUser.isLocal}
      This account has no password today — it signs in through the identity provider. Setting one
      adds a second way in that bypasses the provider, and whatever the provider enforces with it.
    {/if}
  </p>

  <div class="form-group">
    <label for="newPassword">New password</label>
    <input
      type="password"
      id="newPassword"
      bind:value={newPassword}
      placeholder="Min 8 characters"
      autocomplete="new-password"
    />
  </div>
  <div class="form-group">
    <label for="confirmPassword">Repeat it</label>
    <input
      type="password"
      id="confirmPassword"
      bind:value={confirmPassword}
      autocomplete="new-password"
    />
  </div>

  <div class="modal-actions">
    <button class="btn-secondary" onclick={() => (showPasswordModal = false)} title="Close without changing the password">
      Cancel
    </button>
    <button
      class="btn-primary"
      disabled={resetting || !newPassword || !confirmPassword}
      onclick={resetPassword}
      title="Set this password and revoke their sessions"
    >
      {resetting ? 'Setting…' : 'Set password'}
    </button>
  </div>
</Modal>

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

  .source-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    margin-right: 4px;
  }

  .source-badge.oidc {
    background: var(--accent-subtle);
    color: var(--accent-text);
  }

  .source-badge.local {
    background: var(--bg-overlay);
    color: var(--text-muted);
  }

  .synced {
    margin-top: 2px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .team-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 320px;
  }

  .team-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-overlay);
    color: var(--text-secondary);
    font-size: 11px;
    text-decoration: none;
  }

  .team-chip:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .team-chip.manage {
    border-style: dashed;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
  }

  /* ── Membership modal ─────────────────────────────── */

  .modal-note {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 12px;
  }

  .membership-list {
    display: flex;
    flex-direction: column;
  }

  .membership-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .membership-row:last-child {
    border-bottom: none;
  }

  .membership-name {
    color: var(--text-primary);
    font-size: 13px;
    text-decoration: none;
  }

  .membership-name:hover {
    text-decoration: underline;
  }

  .membership-add {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: 10px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }

  .membership-add .form-group {
    margin: 0;
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
