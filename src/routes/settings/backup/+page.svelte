<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { formatBytes, formatDateTime as formatDate } from '$lib/format';
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

</script>

<PageHeader
  title="Azure Blob Storage Backups"
  subtitle="Configure automated daily backups of your database to Azure Blob Storage"
/>

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
    <div class="empty-row">Loading...</div>
  {:else if backups.length === 0}
    <div class="empty-row">No backups found. {backupConfig ? 'Click "Backup Now" to create the first backup.' : 'Configure your storage settings first.'}</div>
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

<style>
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
    font-size: 13px;
  }

  .badge-success { background: var(--green-subtle, #0f3d2e); color: var(--green-text, #6ee7b7); }
  .badge-error { background: var(--red-subtle); color: var(--red-text); }
  .badge-neutral { background: var(--bg-active); color: var(--text-secondary); }

  .form-row {
    margin-bottom: 12px;
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

  @media (max-width: 768px) {
    .form-row {
      grid-template-columns: 1fr;
    }
    .status-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
