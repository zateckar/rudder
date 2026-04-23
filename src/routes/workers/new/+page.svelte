<script lang="ts">
  import { enhance } from '$app/forms';
  
  let { data } = $props();
  let loading = $state(false);
</script>

<header>
  <h1>Add New Worker</h1>
</header>

<div class="form-container">
  <form method="POST" use:enhance={() => {
    loading = true;
    return async ({ update }) => {
      await update();
      loading = false;
    };
  }}>
    <div class="form-section">
      <h2>Worker Details</h2>
      
      <div class="form-group">
        <label for="name">Worker Name</label>
        <input type="text" id="name" name="name" placeholder="e.g., worker-1" required />
      </div>

      <div class="form-group">
        <label for="hostname">Hostname / IP Address</label>
        <input type="text" id="hostname" name="hostname" placeholder="e.g., 192.168.1.100 or worker1.example.com" required />
      </div>

      <div class="form-group">
        <label for="baseDomain">Base Domain (wildcard)</label>
        <input type="text" id="baseDomain" name="baseDomain" placeholder="e.g., gamma.apps.example.com (for *.gamma.apps.example.com)" />
        <span class="form-hint">Used for routing: podman-api.&lt;domain&gt;, &lt;app&gt;.&lt;domain&gt;</span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="sshPort">SSH Port</label>
          <input type="number" id="sshPort" name="sshPort" value="22" required />
        </div>
        <div class="form-group">
          <label for="sshUser">SSH User</label>
          <input type="text" id="sshUser" name="sshUser" placeholder="e.g., root" required />
        </div>
      </div>
    </div>

    <div class="form-section">
      <h2>SSH Key</h2>
      <p class="help-text">Select an SSH key to use for connecting to this worker.</p>
      
      {#if data.sshKeys.length === 0}
        <div class="empty-keys">
          <p>No SSH keys configured yet.</p>
          <a href="/admin" class="btn-secondary">Add SSH Key in Admin</a>
        </div>
      {:else}
        <div class="ssh-keys-list">
          {#each data.sshKeys as key}
            <label class="ssh-key-option">
              <input type="radio" name="sshKeyId" value={key.id} required />
              <span class="key-name">{key.name}</span>
              <span class="key-created">Created: {new Date(key.createdAt).toLocaleDateString()}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>

    <div class="form-actions">
      <a href="/workers" class="btn-secondary">Cancel</a>
      <button type="submit" class="btn-primary" disabled={loading || data.sshKeys.length === 0} title="Create the new worker">
        {loading ? 'Creating...' : 'Create Worker'}
      </button>
    </div>
  </form>
</div>

<style>
  header h1 {
    font-size: 26px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
    margin-bottom: 24px;
  }

  .form-container {
    background: var(--bg-raised);
    padding: 30px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
  }

  .form-section {
    margin-bottom: 30px;
    padding-bottom: 30px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .form-section:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .form-section h2 {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 16px;
    color: var(--text-muted);
  }

  .help-text {
    font-size: 14px;
    color: var(--text-secondary);
    margin-bottom: 16px;
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

  .form-group input[type="text"],
  .form-group input[type="number"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .form-group input::placeholder {
    color: var(--text-muted);
  }

  .form-group input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .form-hint {
    display: block;
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .empty-keys {
    padding: 20px;
    background: var(--bg-overlay);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    text-align: center;
  }

  .empty-keys p {
    color: var(--text-secondary);
    margin-bottom: 12px;
  }

  .ssh-keys-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ssh-key-option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-raised);
    cursor: pointer;
    transition: background 0.15s;
  }

  .ssh-key-option:hover {
    background: var(--bg-hover);
  }

  .ssh-key-option input {
    margin: 0;
    accent-color: var(--accent);
  }

  .key-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .key-created {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .form-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    padding-top: 20px;
    border-top: 1px solid var(--border-subtle);
  }

  .btn-primary,
  .btn-secondary {
    padding: 10px 20px;
    border-radius: var(--radius-sm);
    font-weight: 500;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    border: none;
    transition: background 0.15s;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--text-inverse);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-overlay);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
  }
</style>
