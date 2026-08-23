<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  let { data } = $props();

  // Rows written before actions were classified hold the bare HTTP method.
  const LEGACY_LABELS: Record<string, string> = { POST: 'CREATE', PATCH: 'UPDATE', PUT: 'REPLACE' };

  const ADDITIVE = new Set(['POST', 'CREATE', 'DEPLOY', 'ADOPT', 'IMPORT', 'PROVISION', 'SAVE']);
  const READ_ONLY = new Set(['EXPORT', 'COLLECT', 'RECONCILE', 'REVEAL']);

  function getActionColor(action: string) {
    if (action === 'DELETE' || action === 'PRUNE') return 'action-delete';
    if (ADDITIVE.has(action)) return 'action-create';
    if (READ_ONLY.has(action)) return 'action-default';
    return 'action-update';
  }

  function getActionLabel(action: string) {
    return (LEGACY_LABELS[action] ?? action).replace(/_/g, ' ');
  }
</script>

<PageHeader title="Audit Logs" subtitle="Every change made through Rudder, and who made it." />

<div class="audit-container">
  <div class="filters">
    <p class="subtitle">Showing the 100 most recent actions.</p>
  </div>

  <div class="logs-table-wrapper">
    <table class="logs-table">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>User</th>
          <th>Action</th>
          <th>Resource</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {#each data.logs as log}
          <tr>
            <td class="timestamp">{new Date(log.createdAt).toLocaleString()}</td>
            <td>
              {#if log.user}
                <div class="user-info">
                  <span class="username">{log.user.username}</span>
                </div>
              {:else}
                <span class="api-key-badge">API Key</span>
              {/if}
            </td>
            <td>
              <span class="action-badge {getActionColor(log.action)}">
                {getActionLabel(log.action)}
              </span>
            </td>
            <td>
              <span class="resource-type">{log.resourceType.replace(/_/g, ' ')}</span>
              {#if log.resourceId}
                <span class="resource-id" title={log.resourceId}>{log.resourceId.slice(0, 8)}</span>
              {/if}
            </td>
            <td class="details-cell">
              <code class="details">{log.details}</code>
            </td>
          </tr>
        {/each}
        {#if data.logs.length === 0}
          <tr>
            <td colspan="5" class="empty-row">No audit logs found.</td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
  .audit-container {
    background: var(--bg-raised);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .filters {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-overlay);
  }

  .logs-table-wrapper {
    overflow-x: auto;
  }

  .logs-table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }

  .logs-table th,
  .logs-table td {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 14px;
    color: var(--text-primary);
  }

  .logs-table th {
    background: var(--bg-overlay);
    font-weight: 500;
    color: var(--text-secondary);
    white-space: nowrap;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .logs-table tbody tr:hover {
    background: var(--bg-hover);
  }

  .logs-table tr:last-child td {
    border-bottom: none;
  }

  .timestamp {
    color: var(--text-secondary);
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .user-info {
    display: flex;
    flex-direction: column;
  }

  .username {
    font-weight: 500;
    color: var(--text-primary);
  }

  .api-key-badge {
    background: var(--accent-subtle);
    color: var(--accent-text);
    padding: 4px 10px;
    border-radius: 100px;
    font-size: 12px;
    font-weight: 500;
  }

  .action-badge {
    padding: 4px 10px;
    border-radius: 100px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .action-create {
    background: var(--green-subtle);
    color: var(--green-text);
  }

  .action-update {
    background: var(--yellow-subtle);
    color: var(--yellow);
  }

  .action-delete {
    background: var(--red-subtle);
    color: var(--red-text);
  }

  .action-default {
    background: var(--bg-overlay);
    color: var(--text-secondary);
  }

  .resource-type {
    font-weight: 500;
    text-transform: capitalize;
    color: var(--text-primary);
  }

  /* Enough of the id to match a row against a resource, without a UUID
  dominating the column. The full value is in the title attribute. */
  .resource-id {
    display: block;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  .details-cell {
    max-width: 300px;
  }

  .details {
    background: var(--bg-input);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    word-break: break-all;
    display: block;
    border: 1px solid var(--border-subtle);
  }
</style>
