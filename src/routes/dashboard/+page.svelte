<script lang="ts">
  let { data } = $props();

  let isAdmin = $derived(data.user?.role === 'admin');
  let saturatedWorkers = $derived(
    (data.workerResources || []).filter(w => w.score <= 0 && w.cpuPercent != null)
  );
  let workersWithoutMetrics = $derived(
    (data.workers || []).filter(w => {
      const res = (data.workerResources || []).find(r => r.worker.id === w.id);
      return !res || (res.cpuPercent == null && res.memPercent == null);
    })
  );

  let containerBreakdown = $derived(data.containerStatusBreakdown || {});
  let totalContainers = $derived(
    Object.values(containerBreakdown).reduce((sum: number, n: number) => sum + n, 0)
  );

  function relativeTime(date: Date | string | number): string {
    const now = Date.now();
    const then = new Date(date).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
    return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  }

  function actionIcon(action: string): { symbol: string; cls: string } {
    const upper = action.toUpperCase();
    if (upper.startsWith('CREATE') || upper.startsWith('ADD')) return { symbol: '+', cls: 'action-create' };
    if (upper.startsWith('DELETE') || upper.startsWith('REMOVE')) return { symbol: '\u2212', cls: 'action-delete' };
    return { symbol: '\u270E', cls: 'action-update' };
  }

  function resourceHref(resourceType: string, resourceId: string | null): string | null {
    if (!resourceId) return null;
    const type = resourceType.toLowerCase();
    if (type === 'application') return `/applications/${resourceId}`;
    if (type === 'worker') return `/workers/${resourceId}`;
    if (type === 'team') return `/teams/${resourceId}`;
    if (type === 'container') return `/containers/${resourceId}`;
    if (type === 'user') return `/settings/users`;
    return null;
  }

  function deploymentStatusClass(status: string): string {
    if (status === 'succeeded') return 'dep-succeeded';
    if (status === 'failed') return 'dep-failed';
    if (status === 'running') return 'dep-running';
    if (status === 'rolled_back') return 'dep-rolled-back';
    return 'dep-pending';
  }

  function statusColor(status: string): string {
    const s = status.toLowerCase();
    if (s === 'running') return 'var(--green)';
    if (s === 'error' || s === 'exited') return 'var(--red)';
    if (s === 'created' || s === 'stopped') return 'var(--text-muted)';
    return 'var(--text-secondary)';
  }

  function userInitials(fullName: string | null, username: string | null): string {
    if (fullName) {
      const parts = fullName.trim().split(/\s+/);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      return fullName.slice(0, 2).toUpperCase();
    }
    return (username || '??').slice(0, 2).toUpperCase();
  }
</script>

<header>
  <h1>Dashboard</h1>
</header>

<div class="content">
  {#if isAdmin && (saturatedWorkers.length > 0 || workersWithoutMetrics.length > 0)}
    <div class="alert-banner">
      <div class="alert-header">Worker Capacity Alerts</div>
      {#each saturatedWorkers as w}
        <div class="alert-item">
          <span class="alert-worker">{w.worker.name}</span>
          <span class="alert-detail">
            {#if w.cpuPercent != null}CPU {w.cpuPercent.toFixed(0)}%{/if}
            {#if w.memPercent != null} · MEM {w.memPercent.toFixed(0)}%{/if}
            — over 85% utilization
          </span>
        </div>
      {/each}
      {#each workersWithoutMetrics as w}
        <div class="alert-item">
          <span class="alert-worker">{w.name}</span>
          <span class="alert-detail">No metrics — worker may be offline or metrics not yet collected</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="stats">
    <div class="stat-card">
      <h3>Workers</h3>
      <p class="value">{data.workers?.length || 0}</p>
      <p class="label">Total workers</p>
    </div>
    <div class="stat-card">
      <h3>Applications</h3>
      <p class="value">{data.applications?.length || 0}</p>
      <p class="label">Deployed applications</p>
    </div>
    <div class="stat-card">
      <h3>Containers</h3>
      <p class="value">{data.containers?.length || 0}</p>
      <p class="label">Running containers</p>
    </div>
    <div class="stat-card">
      <h3>Teams</h3>
      <p class="value">{data.teams?.length || 0}</p>
      <p class="label">Active teams</p>
    </div>
  </div>

  <!-- Container Status Breakdown -->
  {#if totalContainers > 0}
    <div class="status-strip">
      <span class="status-strip-label">Container Status</span>
      <div class="status-badges">
        {#each Object.entries(containerBreakdown) as [status, count]}
          <span class="status-badge" style="--badge-color: {statusColor(status)}">
            <span class="status-dot" style="background: {statusColor(status)}"></span>
            {count} {status}
          </span>
        {/each}
      </div>
      <div class="status-bar-track">
        {#each Object.entries(containerBreakdown) as [status, count]}
          <div
            class="status-bar-segment"
            style="width: {(count / totalContainers) * 100}%; background: {statusColor(status)}"
            title="{count} {status}"
          ></div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Recent Activity + Recent Deployments side-by-side -->
  <div class="dashboard-panels">
    <!-- Recent Activity Feed -->
    {#if data.recentActivity && data.recentActivity.length > 0}
      <div class="section panel-activity">
        <h2>Recent Activity</h2>
        <div class="activity-list">
          {#each data.recentActivity as entry (entry.id)}
            {@const icon = actionIcon(entry.action)}
            {@const href = resourceHref(entry.resourceType, entry.resourceId)}
            <div class="activity-item">
              <span class="activity-icon {icon.cls}">{icon.symbol}</span>
              <span class="activity-avatar" title={entry.fullName || entry.username || 'System'}>
                {userInitials(entry.fullName, entry.username)}
              </span>
              <div class="activity-body">
                {#if href}
                  <a href={href} class="activity-desc">
                    <span class="activity-action">{entry.action}</span> {entry.resourceType}
                    {#if entry.details}
                      <span class="activity-detail"> — {entry.details}</span>
                    {/if}
                  </a>
                {:else}
                  <span class="activity-desc">
                    <span class="activity-action">{entry.action}</span> {entry.resourceType}
                    {#if entry.details}
                      <span class="activity-detail"> — {entry.details}</span>
                    {/if}
                  </span>
                {/if}
                <span class="activity-time">{relativeTime(entry.createdAt)}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Recent Deployments -->
    {#if data.recentDeployments && data.recentDeployments.length > 0}
      <div class="section panel-deployments">
        <h2>Recent Deployments</h2>
        <div class="deployment-list">
          {#each data.recentDeployments as dep (dep.id)}
            <div class="deployment-item">
              <div class="deployment-main">
                <a href="/applications/{dep.applicationId}" class="deployment-app">
                  {dep.appName || 'Unknown App'}
                </a>
                <span class="deployment-version">v{dep.version}</span>
                <span class="deployment-badge {deploymentStatusClass(dep.status)}">{dep.status}</span>
              </div>
              <span class="deployment-time">{relativeTime(dep.createdAt)}</span>
            </div>
          {/each}
        </div>
        <div class="panel-footer">
          <a href="/applications" class="view-all-link">View All</a>
        </div>
      </div>
    {/if}
  </div>

  {#if isAdmin && data.workerResources && data.workerResources.length > 0}
    <div class="section">
      <h2>Worker Resources</h2>
      <div class="worker-grid">
        {#each data.workerResources as wr}
          <div class="worker-card" class:saturated={wr.score <= 0 && wr.cpuPercent != null}>
            <div class="worker-card-header">
              <a href="/workers/{wr.worker.id}" class="worker-card-name">{wr.worker.name}</a>
              {#if wr.score <= 0 && wr.cpuPercent != null}
                <span class="badge-saturated">Saturated</span>
              {:else if wr.cpuPercent == null}
                <span class="badge-offline">No Data</span>
              {:else}
                <span class="badge-ok">OK</span>
              {/if}
            </div>
            {#if wr.cpuPercent != null}
              <div class="resource-bars">
                <div class="resource-bar">
                  <span class="bar-label">CPU</span>
                  <div class="bar-track"><div class="bar-fill" class:high={wr.cpuPercent > 75} class:critical={wr.cpuPercent > 85} style="width: {Math.min(wr.cpuPercent, 100)}%"></div></div>
                  <span class="bar-value">{wr.cpuPercent.toFixed(0)}%</span>
                </div>
                <div class="resource-bar">
                  <span class="bar-label">MEM</span>
                  <div class="bar-track"><div class="bar-fill" class:high={wr.memPercent != null && wr.memPercent > 75} class:critical={wr.memPercent != null && wr.memPercent > 85} style="width: {Math.min(wr.memPercent ?? 0, 100)}%"></div></div>
                  <span class="bar-value">{wr.memPercent?.toFixed(0) ?? '—'}%</span>
                </div>
              </div>
              <div class="worker-card-meta">
                {#if wr.containersRunning != null}{wr.containersRunning} containers{/if}
              </div>
            {:else}
              <p class="worker-card-meta muted">Metrics not yet collected</p>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <div class="section">
    <h2>Quick Actions</h2>
    <div class="actions">
      <a href="/workers/new" class="action-btn">Add Worker</a>
      <a href="/applications/new" class="action-btn">New Application</a>
    </div>
  </div>
</div>

<style>
  header {
    margin-bottom: 28px;
  }

  header h1 {
    font-family: var(--font-sans);
    font-size: 28px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .alert-banner {
    background: var(--yellow-subtle);
    border: 1px solid var(--yellow);
    border-left: 3px solid var(--yellow);
    border-radius: var(--radius-md);
    padding: 16px 20px;
    margin-bottom: 24px;
  }

  .alert-header {
    font-family: var(--font-sans);
    font-weight: 700;
    font-size: 11px;
    color: var(--yellow-text);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 10px;
  }

  .alert-item {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 5px 0;
    font-size: 13px;
  }

  .alert-worker {
    font-weight: 600;
    color: var(--text-primary);
  }

  .alert-detail {
    color: var(--text-secondary);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    padding: 24px;
    border-radius: var(--radius-lg);
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .stat-card:hover {
    border-color: var(--border-default);
    box-shadow: var(--shadow-sm);
  }

  .stat-card h3 {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 12px;
  }

  .stat-card .value {
    font-family: var(--font-mono);
    font-size: 40px;
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1;
    margin-bottom: 8px;
  }

  .stat-card .label {
    font-size: 13px;
    color: var(--text-secondary);
  }

  /* Container Status Strip */
  .status-strip {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 16px 24px;
    margin-bottom: 24px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .status-strip-label {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 4px;
  }

  .status-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    flex: 1;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 3px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-bar-track {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-overlay);
    display: flex;
    overflow: hidden;
    margin-top: 2px;
  }

  .status-bar-segment {
    height: 100%;
    transition: width 0.4s ease;
  }

  .status-bar-segment:first-child {
    border-radius: 2px 0 0 2px;
  }

  .status-bar-segment:last-child {
    border-radius: 0 2px 2px 0;
  }

  /* Dashboard panels layout */
  .dashboard-panels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 24px;
  }

  @media (max-width: 900px) {
    .dashboard-panels {
      grid-template-columns: 1fr;
    }
  }

  .panel-activity {
    min-width: 0;
  }

  .panel-deployments {
    min-width: 0;
  }

  /* Activity Feed */
  .activity-list {
    display: flex;
    flex-direction: column;
  }

  .activity-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .activity-item:last-child {
    border-bottom: none;
  }

  .activity-icon {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
  }

  .activity-icon.action-create {
    background: var(--green-subtle);
    color: var(--green-text);
  }

  .activity-icon.action-update {
    background: var(--accent-subtle, rgba(59,130,246,0.1));
    color: var(--accent, #3b82f6);
  }

  .activity-icon.action-delete {
    background: var(--red-subtle, rgba(239,68,68,0.1));
    color: var(--red-text, #dc2626);
  }

  .activity-avatar {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg-overlay);
    color: var(--text-muted);
    font-size: 9px;
    font-weight: 700;
    font-family: var(--font-sans);
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .activity-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .activity-desc {
    font-size: 13px;
    color: var(--text-primary);
    text-decoration: none;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a.activity-desc:hover {
    color: var(--accent);
  }

  .activity-action {
    font-weight: 600;
    text-transform: capitalize;
  }

  .activity-detail {
    color: var(--text-secondary);
    font-weight: 400;
  }

  .activity-time {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  /* Deployment List */
  .deployment-list {
    display: flex;
    flex-direction: column;
  }

  .deployment-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .deployment-item:last-child {
    border-bottom: none;
  }

  .deployment-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .deployment-app {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s;
  }

  .deployment-app:hover {
    color: var(--accent);
  }

  .deployment-version {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .deployment-badge {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .dep-succeeded {
    background: var(--green-subtle);
    color: var(--green-text);
  }

  .dep-failed {
    background: var(--red-subtle, rgba(239,68,68,0.1));
    color: var(--red-text, #dc2626);
  }

  .dep-running {
    background: var(--accent-subtle, rgba(59,130,246,0.1));
    color: var(--accent, #3b82f6);
  }

  .dep-rolled-back {
    background: var(--yellow-subtle);
    color: var(--yellow-text);
  }

  .dep-pending {
    background: var(--bg-overlay);
    color: var(--text-muted);
  }

  .deployment-time {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .panel-footer {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
    text-align: right;
  }

  .view-all-link {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    transition: opacity 0.15s;
  }

  .view-all-link:hover {
    opacity: 0.8;
    text-decoration: underline;
  }

  /* Existing sections */
  .section {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    padding: 28px;
    border-radius: var(--radius-lg);
    margin-bottom: 24px;
  }

  .section h2 {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .worker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
  }

  .worker-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 16px;
    transition: border-color 0.2s;
  }

  .worker-card:hover {
    border-color: var(--border-strong);
  }

  .worker-card.saturated {
    border-color: var(--yellow);
    background: var(--yellow-subtle);
  }

  .worker-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .worker-card-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary);
    text-decoration: none;
    transition: color 0.15s;
  }

  .worker-card-name:hover {
    color: var(--accent);
  }

  .badge-ok, .badge-saturated, .badge-offline {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .badge-ok {
    background: var(--green-subtle);
    color: var(--green-text);
  }

  .badge-saturated {
    background: var(--yellow-subtle);
    color: var(--yellow-text);
  }

  .badge-offline {
    background: var(--bg-overlay);
    color: var(--text-muted);
  }

  .resource-bars {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .resource-bar {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .bar-label {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    width: 30px;
    text-transform: uppercase;
  }

  .bar-track {
    flex: 1;
    height: 5px;
    background: var(--bg-overlay);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--green);
    border-radius: 3px;
    transition: width 0.4s ease;
  }

  .bar-fill.high {
    background: var(--yellow);
  }

  .bar-fill.critical {
    background: var(--red);
  }

  .bar-value {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    width: 38px;
    text-align: right;
  }

  .worker-card-meta {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 10px;
  }

  .worker-card-meta.muted {
    color: var(--text-muted);
    font-style: italic;
  }

  .actions {
    display: flex;
    gap: 12px;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    padding: 10px 22px;
    background: var(--accent);
    color: var(--text-inverse);
    border-radius: var(--radius-md);
    font-weight: 600;
    font-size: 14px;
    text-decoration: none;
    transition: background 0.15s, box-shadow 0.15s;
  }

  .action-btn:hover {
    background: var(--accent-hover);
    box-shadow: var(--shadow-sm);
    text-decoration: none;
  }
</style>
