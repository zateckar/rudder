<script lang="ts">
  import AppLayout from '$lib/components/AppLayout.svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';

  let { data } = $props();

  // Config form
  let storageAccountName = $state('');
  let accessKey = $state('');
  let containerName = $state('rudder-backups');
  let configSaving = $state(false);
  let configError = $state<string | null>(null);
  let configSuccess = $state<string | null>(null);

  // Backup state
  let backupConfig = $state<any>(null);
  let backups = $state<any[]>([]);
  let loading = $state(true);
  let backingUp = $state(false);
  let testing = $state(false);
  let restoring = $state(false);
  let testResult = $state<{ success: boolean; message: string } | null>(null);

  // Restore confirmation
  let confirmRestore = $state<string | null>(null);
  let confirmRestoreText = $state('');

  $effect(() => {
    if (!browser) return;
    loadBackupData();
  });

  async function loadBackupData() {
    loading = true;
    try {
      const res = await fetch('/api/settings/backup');
      if (res.ok) {
        const data = await res.json();
        backupConfig = data.config;
        backups = data.backups || [];
        if (backupConfig) {
          storageAccountName = backupConfig.storageAccountName;
          containerName = backupConfig.containerName;
        }
      }
    } catch (e) {
      console.error('Failed to load backup config:', e);
    } finally {
      loading = false;
    }
  }

  async function saveConfig() {
    configSaving = true;
    configError = null;
    configSuccess = null;
    try {
      const res = await fetch('/api/settings/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageAccountName, accessKey, containerName }),
      });
      const result = await res.json();
      if (!res.ok) {
        configError = result.error || 'Failed to save config';
      } else {
        configSuccess = 'Configuration saved successfully';
        accessKey = '';
        await loadBackupData();
      }
    } catch (e: any) {
      configError = e.message;
    } finally {
      configSaving = false;
    }
  }

  async function testConnectionHandler() {
    testing = true;
    testResult = null;
    try {
      const res = await fetch('/api/settings/backup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      });
      testResult = await res.json();
    } catch (e: any) {
      testResult = { success: false, message: e.message };
    } finally {
      testing = false;
    }
  }

  async function backupNow() {
    backingUp = true;
    try {
      const res = await fetch('/api/settings/backup', { method: 'PUT' });
      const result = await res.json();
      if (result.success) {
        configSuccess = result.message;
        await loadBackupData();
      } else {
        configError = result.message;
      }
    } catch (e: any) {
      configError = e.message;
    } finally {
      backingUp = false;
    }
  }

  async function restoreFromBackup(blobName: string) {
    restoring = true;
    try {
      const res = await fetch('/api/settings/backup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobName }),
      });
      const result = await res.json();
      if (result.success) {
        configSuccess = result.message;
      } else {
        configError = result.message;
      }
    } catch (e: any) {
      configError = e.message;
    } finally {
      restoring = false;
      confirmRestore = null;
      confirmRestoreText = '';
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
  }

  function formatDate(d: any): string {
    if (!d) return 'Never';
    try {
      return new Date(d).toLocaleString();
    } catch {
      return String(d);
    }
  }
</script>

<AppLayout user={data.user} activePage="backup" pathname={$page.url.pathname}>

<header>
  <h1>Azure Blob Storage Backups</h1>
  <p class="subtitle">Configure automated daily backups of your database to Azure Blob Storage</p>
</header>

{#if configError}
  <div class="alert alert-error">{configError}</div>
{/if}
{#if configSuccess}
  <div class="alert alert-success">{configSuccess}</div>
{/if}

<!-- Status Card -->
{#if backupConfig}
  <section class="section">
    <div class="section-header">
      <h2>Backup Status</h2>
      <button class="btn-primary btn-sm" onclick={backupNow} disabled={backingUp}>
        {backingUp ? 'Backing up...' : 'Backup Now'}
      </button>
    </div>
    <div class="status-grid">
      <div class="status-item">
        <span class="status-label">Last Backup</span>
        <span class="status-value">{formatDate(backupConfig.lastBackupAt)}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Status</span>
        <span class="status-value">
          {#if backupConfig.lastBackupStatus === 'success'}
            <span class="badge badge-success">Success</span>
          {:else if backupConfig.lastBackupStatus}
            <span class="badge badge-error">{backupConfig.lastBackupStatus}</span>
          {:else}
            <span class="badge badge-neutral">No backups yet</span>
          {/if}
        </span>
      </div>
      <div class="status-item">
        <span class="status-label">Storage Account</span>
        <span class="status-value mono">{backupConfig.storageAccountName}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Container</span>
        <span class="status-value mono">{backupConfig.containerName}</span>
      </div>
    </div>
  </section>
{/if}

<!-- Configuration Form -->
<section class="section">
  <div class="section-header">
    <h2>Configuration</h2>
    {#if backupConfig}
      <button class="btn-ghost btn-sm" onclick={testConnectionHandler} disabled={testing}>
        {testing ? 'Testing...' : 'Test Connection'}
      </button>
    {/if}
  </div>

  {#if testResult}
    <div class="alert {testResult.success ? 'alert-success' : 'alert-error'}">
      {testResult.message}
    </div>
  {/if}

  <form onsubmit={(e) => { e.preventDefault(); saveConfig(); }}>
    <div class="form-row">
      <div class="form-group">
        <label for="storageAccountName">Storage Account Name</label>
        <input type="text" id="storageAccountName" bind:value={storageAccountName} placeholder="myaccount" required />
        <p class="help-text">Your Azure storage account name</p>
      </div>
      <div class="form-group">
        <label for="containerName">Container Name</label>
        <input type="text" id="containerName" bind:value={containerName} placeholder="rudder-backups" />
        <p class="help-text">Blob container for storing backups</p>
      </div>
    </div>
    <div class="form-group">
      <label for="accessKey">Access Key</label>
      <input type="password" id="accessKey" bind:value={accessKey} placeholder={backupConfig ? '(unchanged — enter new key to update)' : 'Enter your Azure storage access key'} required={!backupConfig} />
      <p class="help-text">Storage account access key. Stored encrypted.</p>
    </div>
    <div class="form-actions-inline">
      <button type="submit" class="btn-primary btn-sm" disabled={configSaving || (!accessKey && !backupConfig) || !storageAccountName}>
        {configSaving ? 'Saving...' : backupConfig ? 'Update Configuration' : 'Save Configuration'}
      </button>
    </div>
  </form>
</section>

<!-- Backup History -->
<section class="section">
  <div class="section-header">
    <h2>Backup History</h2>
    <span class="event-count">{backups.length} backup(s)</span>
  </div>

  {#if loading}
    <div class="empty-state">Loading...</div>
  {:else if backups.length === 0}
    <div class="empty-state">No backups found. {backupConfig ? 'Click "Backup Now" to create the first backup.' : 'Configure your storage settings first.'}</div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Date</th>
            <th class="actions-col">Action</th>
          </tr>
        </thead>
        <tbody>
          {#each backups as backup (backup.name)}
            <tr>
              <td class="cell-name mono">{backup.name}</td>
              <td>{formatBytes(backup.size)}</td>
              <td class="cell-date">{formatDate(backup.lastModified)}</td>
              <td class="actions-col">
                {#if confirmRestore === backup.name}
                  <div class="restore-confirm">
                    <span class="restore-warning">Type "RESTORE" to confirm:</span>
                    <input
                      type="text"
                      class="restore-input"
                      bind:value={confirmRestoreText}
                      placeholder="RESTORE"
                    />
                    <button
                      class="btn-danger btn-sm"
                      disabled={confirmRestoreText !== 'RESTORE' || restoring}
                      onclick={() => restoreFromBackup(backup.name)}
                    >
                      {restoring ? 'Restoring...' : 'Confirm Restore'}
                    </button>
                    <button class="btn-ghost btn-sm" onclick={() => { confirmRestore = null; confirmRestoreText = ''; }}>
                      Cancel
                    </button>
                  </div>
                {:else}
                  <button class="btn-danger btn-sm" onclick={() => confirmRestore = backup.name}>
                    Restore
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

</AppLayout>

<style>
  header { margin-bottom: 28px; }
  header h1 { font-size: 26px; color: var(--text-primary); margin: 0 0 6px; }
  .subtitle { color: var(--text-secondary); font-size: 14px; margin: 0; }

  .section {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin-bottom: 24px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .section-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .status-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .status-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .status-value {
    font-size: 14px;
    color: var(--text-primary);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .alert {
    padding: 12px 16px;
    border-radius: var(--radius-sm);
    margin-bottom: 16px;
    font-size: 14px;
  }

  .alert-error {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
  }

  .alert-success {
    background: var(--green-subtle, #0f3d2e);
    color: var(--green-text, #6ee7b7);
    border: 1px solid var(--green, #10b981);
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-success { background: var(--green-subtle, #0f3d2e); color: var(--green-text, #6ee7b7); }
  .badge-error { background: var(--red-subtle); color: var(--red-text); }
  .badge-neutral { background: var(--bg-active); color: var(--text-secondary); }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: 500;
    font-size: 12px;
    color: var(--text-primary);
  }

  .form-group input[type='text'],
  .form-group input[type='password'] {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
    transition: border-color 0.15s;
    font-family: var(--font-sans);
  }

  .form-group input:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .help-text {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .form-actions-inline {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .btn-primary {
    padding: 8px 16px;
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-sm { padding: 6px 12px; font-size: 12px; }

  .btn-ghost {
    padding: 6px 12px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }

  .btn-danger {
    padding: 6px 12px;
    background: var(--red);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn-danger:hover:not(:disabled) { opacity: 0.9; }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

  .event-count {
    font-size: 12px;
    color: var(--text-muted);
  }

  .table-wrap { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th {
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
  }

  td {
    padding: 10px 12px;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }

  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--bg-hover); }

  .cell-name { font-weight: 500; }
  .cell-date { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
  .actions-col { text-align: right; white-space: nowrap; }

  .restore-confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .restore-warning {
    font-size: 12px;
    color: var(--red-text);
    font-weight: 500;
  }

  .restore-input {
    padding: 4px 8px;
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    font-size: 12px;
    background: var(--bg-input);
    color: var(--text-primary);
    width: 100px;
  }

  .restore-input:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--red-subtle);
  }

  .empty-state {
    text-align: center;
    padding: 32px 16px;
    color: var(--text-muted);
    font-size: 13px;
  }

  @media (max-width: 768px) {
    .form-row {
      grid-template-columns: 1fr;
    }
    .status-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
