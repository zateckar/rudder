<script lang="ts">
  let { data } = $props();

  function getActionColor(action: string) {
    switch (action) {
      case 'POST': return 'action-create';
      case 'PATCH': return 'action-update';
      case 'DELETE': return 'action-delete';
      default: return 'action-default';
    }
  }

  function getActionLabel(action: string) {
    switch (action) {
      case 'POST': return 'CREATE';
      case 'PATCH': return 'UPDATE';
      case 'DELETE': return 'DELETE';
      default: return action;
    }
  }
</script>

<header>
  <div class="header-left">
    <a href="/secrets" class="back-link">← Back to Secrets</a>
    <h1>Audit Logs</h1>
  </div>
</header>

<div class="audit-container">
  <div class="filters">
    <p class="help-text">Showing the 100 most recent actions.</p>
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
              <span class="resource-type">{log.resourceType}</span>
            </td>
            <td class="details-cell">
              <code class="details">{log.details}</code>
            </td>
          </tr>
        {/each}
        {#if data.logs.length === 0}
          <tr>
            <td colspan="5" class="empty-state">No audit logs found.</td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
  header {
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

  .help-text {
    color: var(--text-secondary);
    font-size: 14px;
    margin: 0;
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

  .empty-state {
    text-align: center;
    color: var(--text-muted);
    padding: 40px !important;
  }
</style>
