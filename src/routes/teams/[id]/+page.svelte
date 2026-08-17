<script lang="ts">
  import { browser } from '$app/environment';
  import { showToast } from '$lib/client/toast.svelte';
  import { confirmAction } from '$lib/client/dialog.svelte';

  let { data } = $props();
  
  let showAddMemberForm = $state(false);
  let adding = $state(false);
  let email = $state('');
  let role = $state('member');
  let error = $state<string | null>(null);

  // Quota state
  let quota = $state<any>(null);
  let usage = $state<{ applications: number; containers: number }>({ applications: 0, containers: 0 });
  let showEditQuota = $state(false);
  let quotaSaving = $state(false);
  let quotaMaxCpuCores = $state('');
  let quotaMaxMemoryGB = $state('');
  let quotaMaxContainers = $state('');
  let quotaMaxApplications = $state('');

  const isAdmin = $derived(data.user?.role === 'admin');

  $effect(() => {
    if (!browser) return;
    loadQuota();
  });

  async function loadQuota() {
    try {
      const res = await fetch(`/api/teams/${data.team.id}/quota`);
      if (res.ok) {
        const result = await res.json();
        quota = result.quota;
        usage = result.usage;
        if (quota) {
          quotaMaxCpuCores = quota.maxCpuCores != null ? String(quota.maxCpuCores) : '';
          quotaMaxMemoryGB = quota.maxMemoryBytes != null ? String(Math.round(quota.maxMemoryBytes / (1024 * 1024 * 1024))) : '';
          quotaMaxContainers = quota.maxContainers != null ? String(quota.maxContainers) : '';
          quotaMaxApplications = quota.maxApplications != null ? String(quota.maxApplications) : '';
        }
      }
    } catch (e) {
      console.error('Failed to load quota:', e);
    }
  }

  async function saveQuota() {
    quotaSaving = true;
    try {
      const body: any = {};
      if (quotaMaxCpuCores) body.maxCpuCores = parseFloat(quotaMaxCpuCores);
      else body.maxCpuCores = null;
      if (quotaMaxMemoryGB) body.maxMemoryBytes = parseInt(quotaMaxMemoryGB) * 1024 * 1024 * 1024;
      else body.maxMemoryBytes = null;
      if (quotaMaxContainers) body.maxContainers = parseInt(quotaMaxContainers);
      else body.maxContainers = null;
      if (quotaMaxApplications) body.maxApplications = parseInt(quotaMaxApplications);
      else body.maxApplications = null;

      const res = await fetch(`/api/teams/${data.team.id}/quota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showEditQuota = false;
        await loadQuota();
      } else {
        const result = await res.json();
        showToast('error', result.error || 'Failed to save quota');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      quotaSaving = false;
    }
  }

  function quotaPercent(used: number, max: number | null | undefined): number {
    if (!max) return 0;
    return Math.min(100, Math.round((used / max) * 100));
  }

  async function addMember() {
    error = null;
    adding = true;
    try {
      const response = await fetch(`/api/teams/${data.team.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        error = result.error || 'Failed to add member';
      } else {
        window.location.reload();
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      adding = false;
    }
  }

  async function removeMember(memberId: string) {
    const ok = await confirmAction({
      title: 'Remove this member?',
      body: 'They lose access to this team’s applications, secrets and volumes. Their account is not deleted.',
      confirmLabel: 'Remove member',
      danger: true,
    });
    if (!ok) return;
    
    try {
      const response = await fetch(`/api/teams/${data.team.id}/members?memberId=${memberId}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        window.location.reload();
      } else {
        const result = await response.json();
        showToast('error', result.error || 'Failed to remove member');
      }
    } catch (e: any) {
      showToast('error', e.message);
    }
  }

  async function deleteTeam() {
    const ok = await confirmAction({
      title: `Delete the team "${data.team.name}"?`,
      body: 'This cannot be undone. Applications, secrets and volumes belonging to it lose their team.',
      confirmLabel: 'Delete team',
      danger: true,
    });
    if (!ok) return;
    
    try {
      const response = await fetch(`/api/teams/${data.team.id}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        window.location.href = '/teams';
      } else {
        const result = await response.json();
        showToast('error', result.error || 'Failed to delete team');
      }
    } catch (e: any) {
      showToast('error', e.message);
    }
  }

  // ── API Keys ────────────────────────────────────────────────────

  let showCreateKey = $state(false);
  let creatingKey = $state(false);
  let newKeyName = $state('');
  let newKeyExpiry = $state('');
  let createdKeyValue = $state<string | null>(null);
  let createKeyError = $state<string | null>(null);
  let apiKeysList = $state<any[]>([]);

  $effect(() => {
    apiKeysList = data.apiKeys || [];
  });

  async function createApiKey() {
    createKeyError = null;
    createdKeyValue = null;
    creatingKey = true;
    try {
      const body: any = { name: newKeyName || `kubectl-${data.team.slug}`, teamId: data.team.id };
      if (newKeyExpiry) body.expiresInDays = parseInt(newKeyExpiry);

      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await res.json();
      if (!res.ok) {
        createKeyError = result.error || 'Failed to create API key';
        return;
      }

      createdKeyValue = result.key;
      newKeyName = '';
      newKeyExpiry = '';
      // Reload the list
      const reloadRes = await fetch(`/api/api-keys`);
      if (reloadRes.ok) {
        const reloadData = await reloadRes.json();
        apiKeysList = reloadData.filter((k: any) => k.teamId === data.team.id);
      }
    } catch (e: any) {
      createKeyError = e.message;
    } finally {
      creatingKey = false;
    }
  }

  async function deleteApiKey(keyId: string) {
    const ok = await confirmAction({
      title: 'Revoke this API key?',
      body: 'Anything using it — kubectl, CI, scripts — loses access immediately. This cannot be undone; issue a new key instead.',
      confirmLabel: 'Revoke key',
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/api-keys?id=${keyId}`, { method: 'DELETE' });
      if (res.ok) {
        apiKeysList = apiKeysList.filter(k => k.id !== keyId);
        // The "copy it now" banner was still showing the token of the key that
        // was just revoked, inviting someone to copy a credential that no
        // longer works.
        createdKeyValue = null;
        showToast('success', 'API key revoked');
      } else {
        const result = await res.json();
        showToast('error', result.error || 'Failed to delete API key');
      }
    } catch (e: any) {
      showToast('error', e.message);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('success', 'API key copied to clipboard');
    }).catch(() => {
      // The clipboard API needs a secure context, so this fails over plain
      // HTTP. The key is already on screen in full — select it there rather
      // than putting a live credential into a prompt() the browser may
      // remember, and which some browsers suppress outright.
      showToast('error', 'Could not reach the clipboard — select the key above and copy it manually');
    });
  }

  function dismissKey() {
    createdKeyValue = null;
    showCreateKey = false;
  }

  function formatDate(d: string | Date | null | undefined) {
    if (!d) return 'Never';
    return new Date(d).toLocaleString();
  }

  function isExpired(key: any) {
    if (!key.expiresAt) return false;
    return new Date(key.expiresAt) < new Date();
  }
</script>

<header>
  <div class="header-left">
    <a href="/teams" class="back-link">← Back to Teams</a>
    <h1>{data.team.name}</h1>
    <span class="slug">Slug: {data.team.slug}</span>
  </div>
  <div class="header-actions">
    {#if data.userRole === 'owner'}
      <button class="btn-danger" onclick={deleteTeam}>Delete Team</button>
    {/if}
  </div>
</header>

<div class="team-layout">
  <div class="members-section">
    <div class="section-header">
      <h2>Members</h2>
      {#if data.userRole === 'owner'}
        <button class="btn-primary" onclick={() => showAddMemberForm = !showAddMemberForm}>
          {showAddMemberForm ? 'Cancel' : 'Add Member'}
        </button>
      {/if}
    </div>

    {#if showAddMemberForm}
      <div class="add-member-form">
        <h3>Add New Member</h3>
        {#if error}
          <div class="error-msg">{error}</div>
        {/if}
        <form onsubmit={(e) => { e.preventDefault(); addMember(); }}>
          <div class="form-row">
            <div class="form-group">
              <label for="email">User Email</label>
              <input type="email" id="email" bind:value={email} placeholder="user@example.com" required />
            </div>
            <div class="form-group">
              <label for="role">Role</label>
              <select id="role" bind:value={role}>
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" disabled={adding}>
              {adding ? 'Adding...' : 'Add to Team'}
            </button>
          </div>
        </form>
      </div>
    {/if}

    <div class="members-list">
      {#each data.members as member}
        <div class="member-card">
          <div class="member-info">
            <div class="member-avatar">
              {(member.username || 'U').substring(0, 2).toUpperCase()}
            </div>
            <div>
              <h3>{member.fullName || member.username}</h3>
              <p>{member.email}</p>
            </div>
          </div>
          <div class="member-meta">
            <span class="role-badge {member.role}">{member.role}</span>
            <span class="joined-date">Joined: {new Date(member.joinedAt).toLocaleDateString()}</span>
          </div>
          <div class="member-actions">
            {#if data.userRole === 'owner' && (member.role !== 'owner' || data.user?.id === member.id)}
              <button 
                class="btn-danger btn-small" 
                onclick={() => member.id && removeMember(member.id)}
                disabled={member.id === data.user?.id && data.members.filter((m: any) => m.role === 'owner').length === 1}
                title={member.id === data.user?.id && data.members.filter((m: any) => m.role === 'owner').length === 1 ? 'Cannot remove the last owner' : ''}
              >
                {member.id === data.user?.id ? 'Leave Team' : 'Remove'}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="side-panel">
    <div class="info-card">
      <h3>Team Info</h3>
      <div class="info-row">
        <span>Created:</span>
        <span>{new Date(data.team.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="info-row">
        <span>Members:</span>
        <span>{data.members.length}</span>
      </div>
    </div>

    <!-- Resource Quotas -->
    <div class="info-card quota-card">
      <div class="quota-header">
        <h3>Resource Quotas</h3>
        {#if isAdmin}
          <button class="btn-small btn-ghost-sm" onclick={() => showEditQuota = !showEditQuota}>
            {showEditQuota ? 'Cancel' : 'Edit'}
          </button>
        {/if}
      </div>

      {#if showEditQuota}
        <form onsubmit={(e) => { e.preventDefault(); saveQuota(); }} class="quota-form">
          <div class="quota-field">
            <label for="q-cpu">Max CPU Cores</label>
            <input type="number" id="q-cpu" bind:value={quotaMaxCpuCores} placeholder="No limit" step="0.5" min="0" />
          </div>
          <div class="quota-field">
            <label for="q-mem">Max Memory (GB)</label>
            <input type="number" id="q-mem" bind:value={quotaMaxMemoryGB} placeholder="No limit" min="0" />
          </div>
          <div class="quota-field">
            <label for="q-containers">Max Containers</label>
            <input type="number" id="q-containers" bind:value={quotaMaxContainers} placeholder="No limit" min="0" />
          </div>
          <div class="quota-field">
            <label for="q-apps">Max Applications</label>
            <input type="number" id="q-apps" bind:value={quotaMaxApplications} placeholder="No limit" min="0" />
          </div>
          <button type="submit" class="btn-primary btn-small" disabled={quotaSaving}>
            {quotaSaving ? 'Saving...' : 'Save Quotas'}
          </button>
        </form>
      {:else if quota}
        <div class="quota-meters">
          {#if quota.maxApplications != null}
            <div class="quota-meter">
              <div class="quota-meter-label">
                <span>Applications</span>
                <span class="quota-meter-value">{usage.applications} / {quota.maxApplications}</span>
              </div>
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  class:over={usage.applications > quota.maxApplications}
                  style="width: {quotaPercent(usage.applications, quota.maxApplications)}%"
                ></div>
              </div>
            </div>
          {/if}
          {#if quota.maxContainers != null}
            <div class="quota-meter">
              <div class="quota-meter-label">
                <span>Containers</span>
                <span class="quota-meter-value">{usage.containers} / {quota.maxContainers}</span>
              </div>
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  class:over={usage.containers > quota.maxContainers}
                  style="width: {quotaPercent(usage.containers, quota.maxContainers)}%"
                ></div>
              </div>
            </div>
          {/if}
          {#if quota.maxCpuCores != null}
            <div class="quota-meter">
              <div class="quota-meter-label">
                <span>CPU Cores</span>
                <span class="quota-meter-value">{quota.maxCpuCores}</span>
              </div>
            </div>
          {/if}
          {#if quota.maxMemoryBytes != null}
            <div class="quota-meter">
              <div class="quota-meter-label">
                <span>Memory</span>
                <span class="quota-meter-value">{Math.round(quota.maxMemoryBytes / (1024 * 1024 * 1024))} GB</span>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <p class="no-quota">No quotas set for this team.</p>
      {/if}
    </div>

    <!-- API Keys -->
    <div class="info-card api-keys-card">
      <div class="quota-header">
        <h3>API Keys</h3>
        {#if data.userRole === 'owner'}
          <button class="btn-small btn-ghost-sm" onclick={() => { showCreateKey = !showCreateKey; createdKeyValue = null; createKeyError = null; }}>
            {showCreateKey ? 'Cancel' : '+ New Key'}
          </button>
        {/if}
      </div>

      <p class="api-keys-description">
        Use API keys as Bearer tokens with <code>kubectl</code> or any HTTP client to access this team's resources via the K8s-compatible API at <code>/k8s/</code>.
      </p>

      <div class="api-keys-content">
        {#if showCreateKey}
          <div class="create-key-form">
            {#if createdKeyValue}
              <div class="key-reveal">
                <p class="key-reveal-label">API key created! Copy it now — it will not be shown again.</p>
                <div class="key-value-display">
                  <code>{createdKeyValue}</code>
                  <button class="btn-small btn-primary" onclick={() => copyToClipboard(createdKeyValue!)}>Copy</button>
                </div>
                <button class="btn-small btn-ghost-sm dismiss-btn" onclick={dismissKey}>Dismiss</button>
              </div>
            {:else}
              {#if createKeyError}
                <div class="error-msg">{createKeyError}</div>
              {/if}
              <form onsubmit={(e) => { e.preventDefault(); createApiKey(); }}>
                <div class="quota-field">
                  <label for="key-name">Key Name</label>
                  <input type="text" id="key-name" bind:value={newKeyName} placeholder="kubectl-{data.team.slug}" />
                </div>
                <div class="quota-field">
                  <label for="key-expiry">Expires in (days)</label>
                  <input type="number" id="key-expiry" bind:value={newKeyExpiry} placeholder="Never" min="1" />
                </div>
                <button type="submit" class="btn-primary btn-small" disabled={creatingKey}>
                  {creatingKey ? 'Creating...' : 'Create API Key'}
                </button>
              </form>
            {/if}
          </div>
        {/if}

        {#if apiKeysList.length > 0}
          <div class="api-keys-list">
            {#each apiKeysList as key}
              <div class="api-key-row" class:expired={isExpired(key)}>
                <div class="api-key-info">
                  <span class="api-key-name">{key.name || 'Unnamed'}</span>
                  <span class="api-key-meta">
                    Created: {formatDate(key.createdAt)}
                    {#if key.expiresAt}
                      · Expires: {formatDate(key.expiresAt)}
                    {/if}
                    · Last used: {formatDate(key.lastUsedAt)}
                  </span>
                </div>
                <button class="btn-danger btn-small" onclick={() => deleteApiKey(key.id)} title="Revoke this key">
                  Revoke
                </button>
              </div>
            {/each}
          </div>
        {:else if !showCreateKey}
          <p class="no-quota">No API keys for this team.</p>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }

  .header-left {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .back-link {
    font-size: 14px;
    color: var(--text-secondary);
    text-decoration: none;
  }

  .back-link:hover {
    color: var(--accent);
  }

  header h1 {
    font-size: 28px;
    color: var(--text-primary);
    margin: 0;
  }

  .slug {
    font-size: 13px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .team-layout {
    display: grid;
    grid-template-columns: 1fr 300px;
    gap: 24px;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .section-header h2 {
    font-size: 20px;
    color: var(--text-primary);
    margin: 0;
  }

  .add-member-form {
    background: var(--bg-raised);
    padding: 24px;
    border-radius: var(--radius-lg);
    margin-bottom: 24px;
    border: 1px solid var(--border-subtle);
  }

  .add-member-form h3 {
    font-size: 16px;
    color: var(--text-primary);
    margin-bottom: 16px;
  }

  .error-msg {
    background: var(--red-subtle);
    color: var(--red-text);
    padding: 10px;
    border-radius: var(--radius-sm);
    margin-bottom: 16px;
    font-size: 14px;
    border: 1px solid var(--red);
  }

  .form-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 16px;
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
    font-size: 14px;
    color: var(--text-secondary);
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
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

  .members-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .member-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-raised);
    padding: 16px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    transition: background 0.15s, border-color 0.15s;
  }

  .member-card:hover {
    background: var(--bg-hover);
    border-color: var(--border-default);
  }

  .member-info {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
  }

  .member-avatar {
    width: 40px;
    height: 40px;
    background: var(--accent-subtle);
    color: var(--accent-text);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
  }

  .member-info h3 {
    font-size: 15px;
    margin: 0 0 4px 0;
    color: var(--text-primary);
  }

  .member-info p {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .member-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    margin-right: 24px;
  }

  .role-badge {
    padding: 4px 10px;
    border-radius: 100px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .role-badge.owner {
    background: var(--accent-subtle);
    color: var(--accent-text);
  }

  .role-badge.member {
    background: var(--bg-overlay);
    color: var(--text-secondary);
  }

  .joined-date {
    font-size: 12px;
    color: var(--text-muted);
  }

  .info-card {
    background: var(--bg-raised);
    padding: 20px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
  }

  .info-card h3 {
    font-size: 16px;
    color: var(--text-primary);
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 14px;
  }

  .info-row span:first-child {
    color: var(--text-secondary);
  }

  .info-row span:last-child {
    color: var(--text-primary);
  }

  .btn-primary,
  .btn-danger {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 500;
    border: none;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--text-inverse);
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .btn-danger {
    background: var(--red);
    color: white;
  }

  .btn-danger:hover {
    opacity: 0.9;
  }

  .btn-small {
    padding: 6px 12px;
    font-size: 12px;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .quota-card {
    margin-top: 16px;
  }

  .quota-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .quota-header h3 {
    margin: 0;
    padding: 0;
    border: none;
  }

  .btn-ghost-sm {
    padding: 4px 10px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-ghost-sm:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .quota-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .quota-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .quota-field label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .quota-field input {
    padding: 6px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    width: 100%;
    box-sizing: border-box;
  }

  .quota-field input:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .quota-meters {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .quota-meter-label {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    margin-bottom: 6px;
  }

  .quota-meter-label span:first-child {
    color: var(--text-secondary);
  }

  .quota-meter-value {
    font-weight: 500;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .progress-bar {
    height: 6px;
    background: var(--bg-active);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-fill.over {
    background: var(--red);
  }

  .no-quota {
    font-size: 13px;
    color: var(--text-muted);
    font-style: italic;
    margin: 0;
  }

  .api-keys-card {
    margin-top: 16px;
  }

  .api-keys-description {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: -8px 0 16px 0;
    padding: 0;
  }

  .api-keys-description code {
    font-size: 11px;
    background: var(--bg-overlay);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .api-keys-content {
    padding: 0;
  }

  .api-keys-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .api-key-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-subtle);
    gap: 8px;
  }

  .api-key-row:last-child {
    border-bottom: none;
  }

  .api-key-row.expired {
    opacity: 0.5;
  }

  .api-key-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .api-key-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .api-key-meta {
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .create-key-form {
    margin-bottom: 12px;
  }

  .create-key-form form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .create-key-form form button[type="submit"] {
    margin-top: 4px;
  }

  .key-reveal {
    background: var(--bg-active);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 12px;
    margin-bottom: 12px;
  }

  .key-reveal-label {
    font-size: 12px;
    color: var(--accent-text);
    margin: 0 0 8px 0;
    font-weight: 500;
  }

  .key-value-display {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .key-value-display code {
    flex: 1;
    font-size: 11px;
    background: var(--bg-input);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    word-break: break-all;
    font-family: var(--font-mono);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
  }

  .dismiss-btn {
    margin-top: 8px;
    width: 100%;
    text-align: center;
  }
</style>
