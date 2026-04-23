<script lang="ts">
  import ContainerTerminal from '$lib/components/ContainerTerminal.svelte';
  import YamlEditor from '$lib/components/YamlEditor.svelte';

  let { data } = $props();
  let activeTab = $state('containers');
  let deploying = $state(false);

  // Save as template
  let showTemplateModal = $state(false);
  let templateName = $state('');
  let templateDesc = $state('');
  let templateSaving = $state(false);
  let templateError = $state('');

  // ── Webhook ────────────────────────────────────────────────────────────────
  interface WebhookInfo {
    id: string;
    enabled: boolean;
    lastUsedAt: string | null;
    url: string;
    token?: string; // only present immediately after generation
  }
  let webhook = $state<WebhookInfo | null>(null);
  let webhookLoading = $state(true);
  let webhookGenerating = $state(false);
  let webhookDeleting = $state(false);
  let webhookNewToken = $state<string | null>(null);
  let webhookCopied = $state(false);
  let showWebhookPanel = $state(false);

  async function fetchWebhook() {
    webhookLoading = true;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/webhook`);
      if (res.ok) {
        const body = await res.json();
        webhook = body.webhook;
      }
    } catch { /* ignore */ }
    finally { webhookLoading = false; }
  }

  async function generateWebhook() {
    webhookGenerating = true;
    webhookNewToken = null;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/webhook`, { method: 'POST' });
      const body = await res.json();
      if (res.ok) {
        webhook = body.webhook;
        webhookNewToken = body.webhook.token;
        webhookCopied = false;
        showToast('success', 'Webhook generated');
      } else {
        showToast('error', body.error || 'Failed to generate webhook');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      webhookGenerating = false;
    }
  }

  async function deleteWebhook() {
    if (!confirm('Delete this deploy webhook? Any CI/CD pipelines using it will stop working.')) return;
    webhookDeleting = true;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/webhook`, { method: 'DELETE' });
      if (res.ok) {
        webhook = null;
        webhookNewToken = null;
        showToast('success', 'Webhook deleted');
      } else {
        const body = await res.json();
        showToast('error', body.error || 'Failed to delete webhook');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      webhookDeleting = false;
    }
  }

  async function copyToken() {
    if (!webhookNewToken) return;
    try {
      await navigator.clipboard.writeText(webhookNewToken);
      webhookCopied = true;
      setTimeout(() => { webhookCopied = false; }, 2000);
    } catch {
      showToast('error', 'Failed to copy to clipboard');
    }
  }

  async function copyTriggerUrl() {
    if (!webhook) return;
    const fullUrl = `${window.location.origin}${webhook.url}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      showToast('success', 'Trigger URL copied');
    } catch {
      showToast('error', 'Failed to copy to clipboard');
    }
  }

  // Fetch webhook on mount
  $effect(() => {
    fetchWebhook();
  });

  // Toast notifications
  interface Toast { id: number; type: 'success' | 'error'; message: string }
  let toasts = $state<Toast[]>([]);
  let toastCounter = 0;
  function showToast(type: 'success' | 'error', message: string) {
    const id = ++toastCounter;
    toasts.push({ id, type, message });
    setTimeout(() => { toasts = toasts.filter(t => t.id !== id); }, 4000);
  }

  // ── Deployment history ────────────────────────────────────────────────────
  interface Deployment {
    id: string;
    version: number;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    image: string | null;
    deployedBy: string | null;
    deployedByName: string | null;
    errorMessage: string | null;
    createdAt: string;
    finishedAt: string | null;
  }
  let deploymentsList = $state<Deployment[]>([]);
  let deploymentsLoading = $state(false);
  let deploymentsLoaded = $state(false);
  let rollbackBusy = $state<string | null>(null);

  async function fetchDeployments() {
    deploymentsLoading = true;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/deployments`);
      if (res.ok) {
        const body = await res.json();
        deploymentsList = body.deployments ?? [];
      }
    } catch { /* ignore */ }
    finally {
      deploymentsLoading = false;
      deploymentsLoaded = true;
    }
  }

  async function rollbackTo(dep: Deployment) {
    if (!confirm(`Roll back to version ${dep.version}? This will redeploy the application with that version's configuration.`)) return;
    rollbackBusy = dep.id;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: dep.id }),
      });
      const body = await res.json();
      if (res.ok) {
        showToast('success', body.message || 'Rolled back successfully');
        setTimeout(() => window.location.reload(), 800);
      } else {
        showToast('error', body.error || 'Rollback failed');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      rollbackBusy = null;
    }
  }

  $effect(() => {
    if (activeTab === 'deployments' && !deploymentsLoaded) {
      fetchDeployments();
    }
  });

  // ── App-level actions ────────────────────────────────────────────────────
  async function deployApp(action: string) {
    deploying = true;
    try {
      const res = await fetch('/api/applications/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: data.application.id, action }),
      });
      const body = await res.json();
      if (res.ok) {
        if (action === 'delete') { window.location.href = '/applications'; return; }
        showToast('success', body.message || 'Done');
        if (['deploy', 'start', 'stop', 'restart'].includes(action)) {
          setTimeout(() => window.location.reload(), 800);
        }
      } else {
        showToast('error', body.error || 'Action failed');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      deploying = false;
    }
  }

  // ── Export config ────────────────────────────────────────────────────────
  async function exportApp() {
    try {
      const res = await fetch(`/api/applications/${data.application.id}/export`);
      if (!res.ok) {
        const body = await res.json();
        showToast('error', body.error || 'Export failed');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.application.name}-config.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('success', 'Configuration exported');
    } catch (e: any) {
      showToast('error', e.message);
    }
  }

  // ── Per-container actions ────────────────────────────────────────────────
  let containerBusy = $state<Record<string, boolean>>({});

  async function containerAction(containerId: string, action: string, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    containerBusy[containerId] = true;
    try {
      const res = await fetch(`/api/containers/${containerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (res.ok) {
        const msgs: Record<string, string> = {
          start: 'Container started',
          stop: 'Container stopped',
          restart: 'Container restarted',
          remove: 'Container removed',
        };
        showToast('success', msgs[action] || `Container ${action}ed`);
        setTimeout(() => window.location.reload(), 600);
      } else {
        showToast('error', body.error || `${action} failed`);
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      containerBusy[containerId] = false;
    }
  }

  async function updateContainer(containerId: string) {
    if (!confirm('Pull the latest image and recreate this container?')) return;
    containerBusy[containerId] = true;
    try {
      const res = await fetch(`/api/containers/${containerId}/recreate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pullImage: true }),
      });
      const body = await res.json();
      if (res.ok) {
        showToast('success', 'Container updated');
        setTimeout(() => window.location.reload(), 600);
      } else {
        showToast('error', body.error || 'Update failed');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      containerBusy[containerId] = false;
    }
  }

  // ── Resource limits modal ────────────────────────────────────────────────
  let showLimitsModal = $state(false);
  let selectedContainerForLimits = $state<string | null>(null);
  let limitMemory = $state('');
  let limitCpuQuota = $state('');

  function openLimitsModal(containerId: string) {
    selectedContainerForLimits = containerId;
    limitMemory = '';
    limitCpuQuota = '';
    showLimitsModal = true;
  }

  async function saveLimits() {
    if (!selectedContainerForLimits) return;
    const options: any = { pullImage: false };
    if (limitMemory) {
      const match = limitMemory.match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)$/i);
      if (match) {
        let val = parseFloat(match[1]);
        const u = match[2].toLowerCase();
        if (u === 'k') val *= 1024;
        else if (u === 'm') val *= 1024 * 1024;
        else if (u === 'g') val *= 1024 * 1024 * 1024;
        options.memory = Math.floor(val);
      }
    }
    if (limitCpuQuota) {
      options.cpuQuota = parseFloat(limitCpuQuota) * 100000;
      options.cpuPeriod = 100000;
    }
    showLimitsModal = false;
    containerBusy[selectedContainerForLimits] = true;
    try {
      const res = await fetch(`/api/containers/${selectedContainerForLimits}/recreate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
      const body = await res.json();
      if (res.ok) {
        showToast('success', 'Resource limits applied');
        setTimeout(() => window.location.reload(), 800);
      } else {
        showToast('error', body.error || 'Failed to apply limits');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      if (selectedContainerForLimits) containerBusy[selectedContainerForLimits] = false;
    }
  }

  // ── Image details ────────────────────────────────────────────────────────
  interface ImageDetails {
    name: string; tag: string; fullName: string; digest: string | null;
    created: string; size: number; sizeHuman: string;
    virtualSizeHuman: string; architecture: string; os: string;
    exposedPorts: string[]; env: string[]; cmd: string[]; workingDir: string;
    history: Array<{ id: string; createdAt: string; createdBy: string; sizeHuman: string }>;
  }
  let imageDetails = $state<Record<string, ImageDetails | null | 'loading'>>({});
  let showImageDetails = $state<Record<string, boolean>>({});

  async function toggleImageDetails(containerId: string) {
    showImageDetails[containerId] = !showImageDetails[containerId];
    if (showImageDetails[containerId] && !imageDetails[containerId]) {
      imageDetails[containerId] = 'loading';
      try {
        const res = await fetch(`/api/containers/${containerId}/image`);
        imageDetails[containerId] = res.ok ? await res.json() : null;
      } catch { imageDetails[containerId] = null; }
    }
  }

  // ── Scale modal ──────────────────────────────────────────────────────
  let showScaleModal = $state(false);
  let scaleTarget = $state(1);
  let scaleBusy = $state(false);

  $effect(() => {
    scaleTarget = data.application.replicas ?? 1;
  });

  async function scaleApp() {
    scaleBusy = true;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/scale`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicas: scaleTarget }),
      });
      const body = await res.json();
      if (res.ok) {
        showScaleModal = false;
        showToast('success', body.message || 'Scaling complete');
        setTimeout(() => window.location.reload(), 800);
      } else {
        showToast('error', body.error || 'Scaling failed');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      scaleBusy = false;
    }
  }

  // ── Container health status ──────────────────────────────────────────
  let healthStatus = $state<Record<string, { Status: string; FailingStreak?: number; Log?: any[] } | null>>({});

  async function fetchHealth(containerId: string) {
    try {
      const res = await fetch(`/api/containers/${containerId}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.State?.Health) {
          healthStatus[containerId] = data.State.Health;
        } else {
          healthStatus[containerId] = null;
        }
      }
    } catch {
      healthStatus[containerId] = null;
    }
  }

  // Fetch health status for all containers on mount
  $effect(() => {
    for (const c of data.containers) {
      if (c.status === 'running') {
        fetchHealth(c.containerId);
      }
    }
  });

  // ── Container inspect (for Configuration tab) ─────────────────────────
  let inspectData = $state<Record<string, any | null | 'loading'>>({});

  async function fetchInspect(containerId: string) {
    if (inspectData[containerId]) return;
    inspectData[containerId] = 'loading';
    try {
      const res = await fetch(`/api/containers/${containerId}`);
      inspectData[containerId] = res.ok ? await res.json() : null;
    } catch { inspectData[containerId] = null; }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────
  interface MetricPoint {
    ts: number; cpuPercent: number;
    memUsageBytes: number; memLimitBytes: number; memPercent: number;
    netRxBytes: number; netTxBytes: number;
    blockReadBytes: number; blockWriteBytes: number;
  }

  // Live current snapshot (from stats API — polled while on metrics tab)
  let liveMetrics = $state<Record<string, MetricPoint | null>>({});
  let livePolling: Record<string, ReturnType<typeof setInterval>> = {};

  // Historical from DB
  const RANGES = ['1h','6h','24h','7d','30d'] as const;
  type Range = typeof RANGES[number];
  let selectedRange = $state<Range>('1h');
  let historicalMetrics = $state<Record<string, MetricPoint[] | null>>({});
  let histLoading = $state<Record<string, boolean>>({});

  function formatBytes(b: number): string {
    if (b === 0) return '0 B';
    const k = 1024, sizes = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  async function fetchLive(containerId: string) {
    try {
      const res = await fetch(`/api/containers/${containerId}/stats`);
      if (res.ok) liveMetrics[containerId] = await res.json();
    } catch { /* ignore */ }
  }

  async function fetchHistorical(containerId: string, range: Range) {
    histLoading[containerId] = true;
    try {
      const res = await fetch(`/api/containers/${containerId}/metrics?range=${range}`);
      if (res.ok) {
        const data = await res.json();
        historicalMetrics[containerId] = data.points ?? [];
      } else {
        historicalMetrics[containerId] = [];
      }
    } catch {
      historicalMetrics[containerId] = [];
    } finally {
      histLoading[containerId] = false;
    }
  }

  $effect(() => {
    if (activeTab === 'metrics') {
      for (const c of data.containers) {
        // Live polling every 30s
        if (!livePolling[c.id]) {
          fetchLive(c.id);
          livePolling[c.id] = setInterval(() => fetchLive(c.id), 30_000);
        }
        // Historical fetch
        fetchHistorical(c.id, selectedRange);
      }
    } else {
      for (const [id, timer] of Object.entries(livePolling)) {
        clearInterval(timer);
        delete livePolling[id];
      }
    }
    return () => {
      for (const timer of Object.values(livePolling)) clearInterval(timer);
    };
  });

  // Re-fetch historical when range changes
  $effect(() => {
    const range = selectedRange; // reactive dependency
    if (activeTab === 'metrics') {
      for (const c of data.containers) {
        fetchHistorical(c.id, range);
      }
    }
  });

  /** SVG polyline for time-series data */
  function chartPoints(
    pts: MetricPoint[],
    valueKey: keyof MetricPoint,
    w = 600,
    h = 80
  ): string {
    if (pts.length < 2) return '';
    const vals = pts.map((p) => p[valueKey] as number);
    const maxVal = Math.max(...vals, 1);
    const minTs = pts[0].ts;
    const maxTs = pts[pts.length - 1].ts;
    const tsRange = maxTs - minTs || 1;
    return pts
      .map((p, i) => {
        const x = ((p.ts - minTs) / tsRange) * w;
        const y = h - ((p[valueKey] as number) / maxVal) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<!-- ── Toast container ─────────────────────────────────────────────────── -->
<div class="toasts">
  {#each toasts as toast (toast.id)}
    <div class="toast {toast.type}">{toast.message}</div>
  {/each}
</div>

<!-- ── Header ──────────────────────────────────────────────────────────── -->
<header>
  <div class="header-left">
    <a href="/applications" class="back-link">← Back to Applications</a>
    <div class="title-row">
      <h1>{data.application.name}</h1>
      <span class="type-badge">{data.application.type}</span>
    </div>
    {#if data.application.type === 'compose' && data.serviceUrls && data.serviceUrls.length > 0}
      <div class="service-urls">
        {#each data.serviceUrls as svc}
          <a href={svc.url} target="_blank" rel="noopener" class="app-url">
            🌐 {svc.name}: {svc.url}
            <span class="ext-icon">↗</span>
          </a>
        {/each}
      </div>
    {:else if data.appUrl}
      <a href={data.appUrl} target="_blank" rel="noopener" class="app-url">
        🌐 {data.appUrl}
        <span class="ext-icon">↗</span>
      </a>
    {/if}
    {#if data.application.description}
      <p class="app-description">{data.application.description}</p>
    {/if}
    {#if data.application.gitRepo}
      <div class="git-info">
        <span class="git-label">Git</span>
        <code class="git-value">{data.application.gitRepo}</code>
        <span class="git-branch">{data.application.gitBranch || 'main'}</span>
        {#if data.application.gitDockerfile && data.application.gitDockerfile !== 'Dockerfile'}
          <span class="git-dockerfile">{data.application.gitDockerfile}</span>
        {/if}
      </div>
    {/if}
  </div>
  <div class="header-actions">
    {#if data.worker && data.worker.status === 'online'}
      {@const hasContainers = data.containers.length > 0}
      <button class="btn-header {hasContainers ? 'btn-redeploy' : 'btn-success'}" onclick={() => deployApp('deploy')} disabled={deploying} title="Deploy or redeploy the application">
        {deploying ? 'Deploying…' : hasContainers ? '↻ Redeploy' : '▶ Deploy'}
      </button>
    {/if}
    <a href="/applications/{data.application.id}/edit" class="btn-header btn-secondary">Edit</a>
    {#if data.application.type === 'single'}
      <button class="btn-header btn-secondary" onclick={() => { scaleTarget = data.application.replicas ?? 1; showScaleModal = true; }} title="Scale application replicas">
        Scale ({data.application.replicas ?? 1})
      </button>
    {/if}
    <button class="btn-header btn-secondary" onclick={() => { templateName = ''; templateDesc = ''; templateError = ''; showTemplateModal = true; }} title="Save this application as a reusable template">
      Save as Template
    </button>
    <button class="btn-header btn-secondary" onclick={exportApp} title="Export application configuration as JSON">Export</button>
    <button class="btn-header btn-danger" onclick={() => deployApp('delete')} disabled={deploying} title="Permanently delete this application">Delete</button>
  </div>
</header>

<!-- ── Webhook panel ───────────────────────────────────────────────────── -->
<div class="webhook-section">
  <button class="webhook-toggle" onclick={() => showWebhookPanel = !showWebhookPanel} title="Toggle deploy webhook configuration">
    {showWebhookPanel ? '▾' : '▸'} Deploy Webhook
    {#if webhook}
      <span class="webhook-active-dot" title="Webhook active"></span>
    {/if}
  </button>

  {#if showWebhookPanel}
    <div class="webhook-panel">
      {#if webhookLoading}
        <p class="loading-text">Loading webhook…</p>
      {:else if webhook}
        <div class="webhook-info">
          <div class="webhook-url-row">
            <span class="webhook-label">Trigger URL</span>
            <code class="webhook-url">{window.location.origin}{webhook.url}</code>
            <button class="btn-act btn-copy" onclick={copyTriggerUrl} title="Copy trigger URL to clipboard">Copy URL</button>
          </div>
          {#if webhook.lastUsedAt}
            <div class="webhook-meta">
              <span class="webhook-label">Last triggered</span>
              <span>{new Date(webhook.lastUsedAt).toLocaleString()}</span>
            </div>
          {:else}
            <div class="webhook-meta">
              <span class="webhook-label">Last triggered</span>
              <span class="text-muted">Never</span>
            </div>
          {/if}
        </div>

        {#if webhookNewToken}
          <div class="webhook-token-alert">
            <p class="token-warning">Copy this token now — it will not be shown again.</p>
            <div class="token-row">
              <code class="token-value">{webhookNewToken}</code>
              <button class="btn-act btn-copy" onclick={copyToken} title="Copy token to clipboard">
                {webhookCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div class="webhook-usage">
              <p class="usage-title">Usage:</p>
              <code class="usage-cmd">curl -X POST -H "Authorization: Bearer {'<token>'}" \<br/>  {window.location.origin}{webhook.url}</code>
            </div>
          </div>
        {/if}

        <div class="webhook-actions">
          <button class="btn-act" onclick={generateWebhook} disabled={webhookGenerating} title="Generate a new token (invalidates the old one)">
            {webhookGenerating ? 'Generating…' : 'Regenerate'}
          </button>
          <button class="btn-act btn-stop" onclick={deleteWebhook} disabled={webhookDeleting} title="Delete webhook permanently">
            {webhookDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      {:else}
        <p class="webhook-empty">No deploy webhook configured. Generate one to enable CI/CD triggers.</p>
        <button class="btn-act btn-start" onclick={generateWebhook} disabled={webhookGenerating} title="Generate a new deploy webhook token">
          {webhookGenerating ? 'Generating…' : 'Generate Webhook'}
        </button>
      {/if}
    </div>
  {/if}
</div>

<!-- ── Tabs ────────────────────────────────────────────────────────────── -->
<div class="tabs">
  {#each [['containers','Containers'],['metrics','Metrics'],['config','Configuration'],['deployments','Deployments']] as [id, label]}
    <button class:active={activeTab === id} onclick={() => activeTab = id}>{label}</button>
  {/each}
</div>

<div class="tab-content">
  <!-- ── Containers tab ─────────────────────────────────────────────────── -->
  {#if activeTab === 'containers'}
    {#if data.containers.length === 0}
      <div class="empty-state">
        <p>No containers deployed yet.</p>
        {#if data.worker?.status === 'online'}
          <button class="btn-primary" onclick={() => deployApp('deploy')} title="Deploy this application for the first time">Deploy Application</button>
        {/if}
      </div>
    {:else}
      <div class="containers-list">
        {#each data.containers as container}
          {@const busy = containerBusy[container.id] ?? false}
          {@const isRunning = container.status === 'running'}
          <div class="container-card">
            <div class="container-header">
              <div class="container-title">
                <h3>{container.name}</h3>
                <span class="status-badge {container.status}">{container.status}</span>
                {#if container.status === 'running'}
                  {@const health = healthStatus[container.containerId]}
                  {#if health === undefined}
                    <!-- loading -->
                  {:else if health === null}
                    <span class="health-indicator health-none" title="No health check configured">—</span>
                  {:else if health.Status === 'healthy'}
                    <span class="health-indicator health-healthy" title="Healthy"></span>
                  {:else if health.Status === 'unhealthy'}
                    <span class="health-indicator health-unhealthy" title="Unhealthy (failing streak: {health.FailingStreak ?? 0})"></span>
                  {:else if health.Status === 'starting'}
                    <span class="health-indicator health-starting" title="Health check starting..."></span>
                  {:else}
                    <span class="health-indicator health-none" title="Health: {health.Status}">—</span>
                  {/if}
                {/if}
              </div>
              <div class="container-actions">
                {#if isRunning}
                  <button
                    class="btn-act btn-stop"
                    onclick={() => containerAction(container.id, 'stop', 'Stop this container?')}
                    disabled={busy}
                    title="Stop this container"
                  >Stop</button>
                  <button
                    class="btn-act"
                    onclick={() => containerAction(container.id, 'restart')}
                    disabled={busy}
                    title="Restart this container without pulling"
                  >Restart</button>
                {:else}
                  <button
                    class="btn-act btn-start"
                    onclick={() => containerAction(container.id, 'start')}
                    disabled={busy}
                    title="Start this container"
                  >Start</button>
                {/if}
                <button
                  class="btn-act"
                  onclick={() => updateContainer(container.id)}
                  disabled={busy}
                  title="Pull latest image and recreate this container"
                >Update</button>
                <button
                  class="btn-act"
                  onclick={() => openLimitsModal(container.id)}
                  disabled={busy}
                  title="Set memory and CPU limits for this container"
                >Limits</button>
              </div>
            </div>

            <div class="container-meta">
              <div class="meta-item">
                <span class="meta-label">Image</span>
                <span class="meta-value mono">{container.image}</span>
              </div>
              {#if container.containerId}
                <div class="meta-item">
                  <span class="meta-label">Container ID</span>
                  <span class="meta-value mono">{container.containerId.substring(0, 12)}</span>
                </div>
              {/if}
              {#if container.exposedPort}
                <div class="meta-item">
                  <span class="meta-label">Host Port</span>
                  <span class="meta-value mono">{container.exposedPort}</span>
                </div>
              {/if}
            </div>

            <!-- Image details toggle -->
            <button
              class="image-details-toggle"
              onclick={() => toggleImageDetails(container.id)}
              title="Show or hide image details"
            >
              {showImageDetails[container.id] ? '▾' : '▸'} Image Details
            </button>

            {#if showImageDetails[container.id]}
              <div class="image-details-panel">
                {#if imageDetails[container.id] === 'loading'}
                  <p class="loading-text">Loading image details…</p>
                {:else if !imageDetails[container.id]}
                  <p class="error-text">Could not load image details</p>
                {:else}
                  {@const img = imageDetails[container.id] as ImageDetails}
                  <div class="img-info-grid">
                    <div><span class="img-label">Name</span><span class="mono">{img.name}</span></div>
                    <div><span class="img-label">Tag</span><span class="mono">{img.tag}</span></div>
                    <div><span class="img-label">Size</span><span>{img.sizeHuman}</span></div>
                    <div><span class="img-label">Created</span><span>{new Date(img.created).toLocaleString()}</span></div>
                    <div><span class="img-label">OS / Arch</span><span>{img.os} / {img.architecture}</span></div>
                    {#if img.workingDir}
                      <div><span class="img-label">Working Dir</span><span class="mono">{img.workingDir}</span></div>
                    {/if}
                    {#if img.exposedPorts.length > 0}
                      <div><span class="img-label">Exposed Ports</span><span class="mono">{img.exposedPorts.join(', ')}</span></div>
                    {/if}
                  </div>
                  {#if img.env.length > 0}
                    <div class="img-section">
                      <p class="img-section-title">Built-in Environment</p>
                      {#each img.env as e}
                        <div class="mono small">{e}</div>
                      {/each}
                    </div>
                  {/if}
                  {#if img.history.length > 0}
                    <div class="img-section">
                      <p class="img-section-title">Layer History (Dockerfile)</p>
                      <table class="history-table">
                        <thead>
                          <tr><th>Created</th><th>Command</th><th>Size</th></tr>
                        </thead>
                        <tbody>
                          {#each img.history as layer}
                            <tr>
                              <td class="nowrap">{new Date(layer.createdAt).toLocaleDateString()}</td>
                              <td class="mono small layer-cmd">{layer.createdBy}</td>
                              <td class="nowrap">{layer.sizeHuman}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                      <p class="img-note">Layer history reconstructed from image metadata, not the original Dockerfile.</p>
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}

            <ContainerTerminal containerId={container.id} />
          </div>
        {/each}
      </div>
    {/if}

  <!-- ── Metrics tab ──────────────────────────────────────────────────── -->
  {:else if activeTab === 'metrics'}
    {#if data.containers.length === 0}
      <div class="empty-state"><p>Deploy the application first to see metrics.</p></div>
    {:else}
      <!-- Range selector -->
      <div class="range-bar">
        <span class="range-label">Time range:</span>
        {#each RANGES as r}
          <button
            class="range-btn"
            class:active={selectedRange === r}
            onclick={() => selectedRange = r}
            title="Show metrics for last {r}"
          >{r}</button>
        {/each}
        <span class="range-hint">Background collection every 60 s · Data kept 30 days</span>
      </div>

      <div class="metrics-grid">
        {#each data.containers as container}
          {@const live = liveMetrics[container.id]}
          {@const hist = historicalMetrics[container.id] ?? []}
          {@const loading = histLoading[container.id]}
          <div class="metrics-card">
            <h3>{container.name}</h3>

            <!-- Current snapshot -->
            {#if live}
              <div class="live-snapshot">
                <div class="snap-item">
                  <span class="snap-label">CPU</span>
                  <span class="snap-value {live.cpuPercent > 80 ? 'warn' : ''}">{live.cpuPercent.toFixed(1)}%</span>
                  <div class="mini-bar"><div class="mini-fill cpu" style="width:{Math.min(live.cpuPercent,100)}%"></div></div>
                </div>
                <div class="snap-item">
                  <span class="snap-label">Memory</span>
                  <span class="snap-value {live.memPercent > 80 ? 'warn' : ''}">{live.memPercent.toFixed(1)}%</span>
                  <div class="mini-bar"><div class="mini-fill mem" style="width:{Math.min(live.memPercent,100)}%"></div></div>
                </div>
                <div class="snap-item">
                  <span class="snap-label">RAM used</span>
                  <span class="snap-value">{formatBytes(live.memUsageBytes)}</span>
                </div>
                <div class="snap-item">
                  <span class="snap-label">Net RX / TX</span>
                  <span class="snap-value">↓{formatBytes(live.netRxBytes)} ↑{formatBytes(live.netTxBytes)}</span>
                </div>
              </div>
            {:else}
              <p class="loading-text">Fetching current snapshot…</p>
            {/if}

            <!-- Historical charts -->
            {#if loading}
              <p class="loading-text">Loading {selectedRange} history…</p>
            {:else if hist.length < 2}
              <div class="no-history">
                <p>No historical data yet for <strong>{selectedRange}</strong>.</p>
                <p class="small">Data is collected in the background every 60 seconds. Come back shortly.</p>
              </div>
            {:else}
              <!-- CPU chart -->
              <div class="chart-block">
                <div class="chart-header">
                  <span class="metric-label">CPU % — {selectedRange}</span>
                  <span class="metric-value">{hist[hist.length-1].cpuPercent.toFixed(1)}% now</span>
                </div>
                <svg class="chart-svg" viewBox="0 0 600 80" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="cpu-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.3"/>
                      <stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/>
                    </linearGradient>
                  </defs>
                  <polygon
                    points="{chartPoints(hist,'cpuPercent')} 600,80 0,80"
                    fill="url(#cpu-grad)"
                  />
                  <polyline points={chartPoints(hist,'cpuPercent')} fill="none" stroke="var(--blue)" stroke-width="2"/>
                </svg>
                <div class="chart-times">
                  <span>{formatTime(hist[0].ts)}</span>
                  <span>{formatTime(hist[hist.length-1].ts)}</span>
                </div>
              </div>

              <!-- Memory chart -->
              <div class="chart-block">
                <div class="chart-header">
                  <span class="metric-label">Memory % — {selectedRange}</span>
                  <span class="metric-value">{formatBytes(hist[hist.length-1].memUsageBytes)} / {formatBytes(hist[hist.length-1].memLimitBytes)}</span>
                </div>
                <svg class="chart-svg" viewBox="0 0 600 80" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="mem-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="var(--green)" stop-opacity="0.3"/>
                      <stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>
                    </linearGradient>
                  </defs>
                  <polygon
                    points="{chartPoints(hist,'memPercent')} 600,80 0,80"
                    fill="url(#mem-grad)"
                  />
                  <polyline points={chartPoints(hist,'memPercent')} fill="none" stroke="var(--green)" stroke-width="2"/>
                </svg>
                <div class="chart-times">
                  <span>{formatTime(hist[0].ts)}</span>
                  <span>{formatTime(hist[hist.length-1].ts)}</span>
                </div>
              </div>

              <!-- Network chart -->
              <div class="chart-block">
                <div class="chart-header">
                  <span class="metric-label">Network I/O — {selectedRange}</span>
                  <div class="legend">
                    <span class="legend-item" style="color:var(--accent)">— RX</span>
                    <span class="legend-item" style="color:var(--purple)">- - TX</span>
                  </div>
                </div>
                <svg class="chart-svg" viewBox="0 0 600 80" preserveAspectRatio="none">
                  <polyline points={chartPoints(hist,'netRxBytes')} fill="none" stroke="var(--accent)" stroke-width="2"/>
                  <polyline points={chartPoints(hist,'netTxBytes')} fill="none" stroke="var(--purple)" stroke-width="1.5" stroke-dasharray="6 3"/>
                </svg>
                <div class="chart-times">
                  <span>{formatTime(hist[0].ts)}</span>
                  <span>{formatTime(hist[hist.length-1].ts)}</span>
                </div>
              </div>

              <!-- Disk chart -->
              <div class="chart-block">
                <div class="chart-header">
                  <span class="metric-label">Disk I/O — {selectedRange}</span>
                  <div class="legend">
                    <span class="legend-item" style="color:var(--red)">— Read</span>
                    <span class="legend-item" style="color:var(--blue-text)">- - Write</span>
                  </div>
                </div>
                <svg class="chart-svg" viewBox="0 0 600 80" preserveAspectRatio="none">
                  <polyline points={chartPoints(hist,'blockReadBytes')} fill="none" stroke="var(--red)" stroke-width="2"/>
                  <polyline points={chartPoints(hist,'blockWriteBytes')} fill="none" stroke="var(--blue-text)" stroke-width="1.5" stroke-dasharray="6 3"/>
                </svg>
                <div class="chart-times">
                  <span>{formatTime(hist[0].ts)}</span>
                  <span>{formatTime(hist[hist.length-1].ts)}</span>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

  <!-- ── Deployments tab ──────────────────────────────────────────────── -->
  {:else if activeTab === 'deployments'}
    {#if deploymentsLoading && !deploymentsLoaded}
      <div class="empty-state"><p class="loading-text">Loading deployment history...</p></div>
    {:else if deploymentsList.length === 0}
      <div class="empty-state"><p>No deployments recorded yet.</p></div>
    {:else}
      <div class="deployments-list">
        <table class="deployments-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Image</th>
              <th>Deployed By</th>
              <th>Deployed</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each deploymentsList as dep, i (dep.id)}
              {@const isLatest = i === 0}
              {@const isBusy = rollbackBusy === dep.id}
              <tr class="deployment-row" class:latest={isLatest}>
                <td class="version-cell">
                  <span class="version-number">v{dep.version}</span>
                  {#if isLatest}
                    <span class="current-badge">current</span>
                  {/if}
                </td>
                <td>
                  <span class="deploy-status-badge {dep.status}">{dep.status.replace('_', ' ')}</span>
                </td>
                <td class="mono image-cell" title={dep.image ?? ''}>
                  {#if dep.image}
                    {dep.image.length > 40 ? dep.image.substring(0, 40) + '...' : dep.image}
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                </td>
                <td>
                  {#if dep.deployedByName}
                    {dep.deployedByName}
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                </td>
                <td class="nowrap">
                  {new Date(dep.createdAt).toLocaleString()}
                </td>
                <td class="nowrap">
                  {#if dep.finishedAt && dep.createdAt}
                    {@const ms = new Date(dep.finishedAt).getTime() - new Date(dep.createdAt).getTime()}
                    {#if ms < 1000}
                      &lt;1s
                    {:else if ms < 60000}
                      {Math.round(ms / 1000)}s
                    {:else}
                      {Math.round(ms / 60000)}m {Math.round((ms % 60000) / 1000)}s
                    {/if}
                  {:else if dep.status === 'pending'}
                    <span class="text-muted">in progress</span>
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                </td>
                <td>
                  {#if !isLatest && dep.status === 'succeeded'}
                    <button
                      class="btn-act btn-rollback"
                      onclick={() => rollbackTo(dep)}
                      disabled={isBusy || rollbackBusy !== null}
                      title="Roll back to version {dep.version}"
                    >
                      {isBusy ? 'Rolling back...' : 'Rollback'}
                    </button>
                  {/if}
                  {#if dep.errorMessage}
                    <button
                      class="btn-act btn-error-detail"
                      onclick={() => alert(dep.errorMessage)}
                      title="View error details"
                    >Error</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- ── Configuration tab ──────────────────────────────────────────────── -->
  {:else if activeTab === 'config'}
    {#if data.containers.length === 0}
      <div class="section"><p class="empty">Deploy the application first to see container configuration.</p></div>
    {:else}
      {#each data.containers as container}
        <div class="inspect-section">
          <div class="inspect-header">
            <h3>{container.name}</h3>
            <span class="status-badge {container.status}">{container.status}</span>
          </div>

          {#if !inspectData[container.id]}
            <button class="btn-load" onclick={() => fetchInspect(container.id)} title="Fetch container inspection data from Podman">Load Inspect Data</button>
          {:else if inspectData[container.id] === 'loading'}
            <p class="loading">Loading…</p>
          {:else if inspectData[container.id] === null}
            <p class="error">Could not load inspect data</p>
          {:else}
            {@const c = inspectData[container.id]}
            {@const state = c.State || {}}
            {@const config = c.Config || {}}
            {@const host = c.HostConfig || {}}
            {@const net = c.NetworkSettings || {}}

            <!-- State -->
            <div class="info-group">
              <h4>State</h4>
              <div class="kv-grid">
                <div class="kv"><span class="k">Status</span><span class="v">{state.Status}</span></div>
                <div class="kv"><span class="k">PID</span><span class="v">{state.Pid || '—'}</span></div>
                <div class="kv"><span class="k">Exit Code</span><span class="v">{state.ExitCode ?? '—'}</span></div>
                {#if state.StartedAt}
                  <div class="kv"><span class="k">Started</span><span class="v">{new Date(state.StartedAt).toLocaleString()}</span></div>
                {/if}
                {#if state.FinishedAt && state.FinishedAt !== '0001-01-01T00:00:00Z'}
                  <div class="kv"><span class="k">Finished</span><span class="v">{new Date(state.FinishedAt).toLocaleString()}</span></div>
                {/if}
              </div>
            </div>

            <!-- Image & Command -->
            <div class="info-group">
              <h4>Image & Command</h4>
              <div class="kv-grid">
                <div class="kv"><span class="k">Image</span><span class="v mono">{config.Image || c.Image}</span></div>
                {#if config.Cmd}
                  <div class="kv"><span class="k">Command</span><span class="v mono">{config.Cmd.join(' ')}</span></div>
                {/if}
                {#if config.Entrypoint}
                  <div class="kv"><span class="k">Entrypoint</span><span class="v mono">{Array.isArray(config.Entrypoint) ? config.Entrypoint.join(' ') : config.Entrypoint}</span></div>
                {/if}
                {#if config.WorkingDir}
                  <div class="kv"><span class="k">Working Dir</span><span class="v mono">{config.WorkingDir}</span></div>
                {/if}
              </div>
            </div>

            <!-- Resource Limits -->
            <div class="info-group">
              <h4>Resource Limits</h4>
              <div class="kv-grid">
                <div class="kv">
                  <span class="k">Memory</span>
                  <span class="v">{host.Memory ? `${(host.Memory / 1048576).toFixed(0)} MB` : 'No limit'}</span>
                </div>
                <div class="kv">
                  <span class="k">CPU</span>
                  <span class="v">{host.CpuQuota && host.CpuPeriod ? `${(host.CpuQuota / host.CpuPeriod).toFixed(2)} cores` : 'No limit'}</span>
                </div>
                <div class="kv">
                  <span class="k">Restart Policy</span>
                  <span class="v">{host.RestartPolicy?.Name || 'no'}</span>
                </div>
              </div>
            </div>

            <!-- Network -->
            {#if net.Networks && Object.keys(net.Networks).length > 0}
              <div class="info-group">
                <h4>Network</h4>
                {#each Object.entries(net.Networks) as [name, nw]}
                  {@const network = nw as any}
                  <div class="net-card">
                    <span class="net-name">{name}</span>
                    <div class="kv-grid compact">
                      {#if network.IPAddress}
                        <div class="kv"><span class="k">IP</span><span class="v mono">{network.IPAddress}</span></div>
                      {/if}
                      {#if network.Gateway}
                        <div class="kv"><span class="k">Gateway</span><span class="v mono">{network.Gateway}</span></div>
                      {/if}
                      {#if network.MacAddress}
                        <div class="kv"><span class="k">MAC</span><span class="v mono">{network.MacAddress}</span></div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Port Bindings -->
            {#if host.PortBindings && Object.keys(host.PortBindings).length > 0}
              <div class="info-group">
                <h4>Port Bindings</h4>
                <div class="kv-grid">
                  {#each Object.entries(host.PortBindings) as [containerPort, bindList]}
                    <div class="kv">
                      <span class="k mono">{containerPort}</span>
                      <span class="v mono">{(bindList as any[]).map((b: any) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`).join(', ')}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Mounts -->
            {#if c.Mounts && c.Mounts.length > 0}
              <div class="info-group">
                <h4>Mounts</h4>
                <table class="mini-table">
                  <thead><tr><th>Source</th><th>Destination</th><th>Mode</th><th>Type</th></tr></thead>
                  <tbody>
                    {#each c.Mounts as mount}
                      <tr>
                        <td class="mono">{mount.Source || '—'}</td>
                        <td class="mono">{mount.Destination || '—'}</td>
                        <td>{mount.RW ? 'rw' : 'ro'}</td>
                        <td>{mount.Type}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}

            <!-- Environment -->
            {#if config.Env && config.Env.length > 0}
              <div class="info-group">
                <h4>Environment</h4>
                <div class="env-list">
                  {#each config.Env as env}
                    <div class="mono env-line">{env}</div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Labels -->
            {#if config.Labels && Object.keys(config.Labels).length > 0}
              <div class="info-group">
                <h4>Labels</h4>
                <div class="kv-grid compact">
                  {#each Object.entries(config.Labels) as [key, val]}
                    <div class="kv"><span class="k mono label-key">{key}</span><span class="v mono label-val">{val}</span></div>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<!-- ── Limits modal ───────────────────────────────────────────────────── -->
{#if showLimitsModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showLimitsModal = false} onkeydown={(e) => e.key === 'Escape' && (showLimitsModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Update Resource Limits</h3>
      <p class="help-text">Limits will be applied by recreating the container (no image pull).</p>
      <div class="form-group">
        <label for="limitMemory">Memory Limit (e.g. 512m, 1g)</label>
        <input id="limitMemory" type="text" bind:value={limitMemory} placeholder="Leave empty for no limit" />
      </div>
      <div class="form-group">
        <label for="limitCpuQuota">CPU Limit (e.g. 0.5 for half a core, 2 for 2 cores)</label>
        <input id="limitCpuQuota" type="text" bind:value={limitCpuQuota} placeholder="Leave empty for no limit" />
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick={() => showLimitsModal = false} title="Close without applying limits">Cancel</button>
        <button class="btn-primary" onclick={saveLimits} title="Apply resource limits by recreating the container">Apply Limits</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Save as Template modal ──────────────────────────────────────── -->
{#if showTemplateModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showTemplateModal = false} onkeydown={(e) => e.key === 'Escape' && (showTemplateModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Save as Template</h3>
      <p class="help-text">Create a reusable template from <strong>{data.application.name}</strong>.</p>
      {#if templateError}
        <div class="template-error">{templateError}</div>
      {/if}
      <div class="form-group">
        <label for="tplName">Template Name</label>
        <input id="tplName" type="text" bind:value={templateName} placeholder="my-template" />
      </div>
      <div class="form-group">
        <label for="tplDesc">Description (optional)</label>
        <input id="tplDesc" type="text" bind:value={templateDesc} placeholder="What this template deploys" />
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick={() => showTemplateModal = false} title="Close without saving">Cancel</button>
        <button
          class="btn-primary"
          disabled={templateSaving || !templateName.trim()}
          title="Save this application configuration as a template"
          onclick={async () => {
            templateSaving = true;
            templateError = '';
            try {
              const fd = new FormData();
              fd.append('appId', data.application.id);
              fd.append('name', templateName.trim());
              fd.append('description', templateDesc.trim());
              const res = await fetch('/api/templates/save', { method: 'POST', body: fd });
              const body = await res.json();
              if (res.ok) {
                showTemplateModal = false;
                showToast('success', 'Template saved');
              } else {
                templateError = body.error || 'Failed to save';
              }
            } catch (e: any) {
              templateError = e.message;
            } finally {
              templateSaving = false;
            }
          }}
        >
          {templateSaving ? 'Saving…' : 'Save Template'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Scale modal ────────────────────────────────────────────────── -->
{#if showScaleModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => showScaleModal = false} onkeydown={(e) => e.key === 'Escape' && (showScaleModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Scale Application</h3>
      <p class="help-text">Set the number of container replicas for <strong>{data.application.name}</strong>. Traefik will load-balance across all replicas.</p>
      <div class="form-group">
        <label for="scaleReplicas">Replicas</label>
        <input id="scaleReplicas" type="number" bind:value={scaleTarget} min="1" max="10" />
        <p class="scale-hint">
          Current: {data.application.replicas ?? 1} replica{(data.application.replicas ?? 1) !== 1 ? 's' : ''}
          {#if scaleTarget !== (data.application.replicas ?? 1)}
            &rarr; {scaleTarget} replica{scaleTarget !== 1 ? 's' : ''}
          {/if}
        </p>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick={() => showScaleModal = false} title="Close without scaling">Cancel</button>
        <button class="btn-primary" onclick={scaleApp} disabled={scaleBusy || scaleTarget === (data.application.replicas ?? 1)} title="Apply scaling">
          {scaleBusy ? 'Scaling...' : 'Apply'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Toast ─────────────────────────────────────────────────────────── */
  .toasts {
    position: fixed; top: 20px; right: 20px; z-index: 2000;
    display: flex; flex-direction: column; gap: 8px;
  }
  .toast {
    padding: 12px 20px; border-radius: var(--radius-md); font-size: 14px; font-weight: 500;
    box-shadow: var(--shadow-md); animation: slide-in 0.2s ease;
  }
  .toast.success { background: var(--green-subtle); color: var(--green-text); border: 1px solid var(--green); }
  .toast.error   { background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red); }
  @keyframes slide-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  /* ── Header ────────────────────────────────────────────────────────── */
  header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: 24px; gap: 16px; flex-wrap: wrap;
  }
  .header-left { display: flex; flex-direction: column; gap: 6px; }
  .back-link { font-size: 13px; color: var(--text-muted); text-decoration: none; transition: color 0.15s; }
  .back-link:hover { color: var(--text-primary); }
  .title-row { display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 26px; color: var(--text-primary); margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  .type-badge {
    padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
    background: var(--blue-subtle); color: var(--blue-text);
  }
  .app-url {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--accent); text-decoration: none;
    background: var(--accent-subtle); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    padding: 5px 12px; border-radius: 20px; width: fit-content; font-family: var(--font-mono);
    transition: all 0.15s;
  }
  .app-url:hover { background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .service-urls { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .service-urls .app-url { font-size: 12px; }
  .ext-icon { font-size: 11px; opacity: 0.7; }
  .app-description { font-size: 13px; color: var(--text-muted); margin: 4px 0 0; max-width: 500px; }
  .git-info {
    display: flex; align-items: center; gap: 8px; margin-top: 6px;
    font-size: 12px; flex-wrap: wrap;
  }
  .git-label {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 2px 8px; border-radius: 10px;
    background: var(--purple-subtle); color: var(--purple);
  }
  .git-value {
    font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);
    background: var(--bg-overlay); padding: 3px 8px; border-radius: var(--radius-sm);
    max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .git-branch {
    font-size: 11px; font-weight: 600; color: var(--green-text);
    background: var(--green-subtle); padding: 2px 8px; border-radius: 10px;
  }
  .git-dockerfile {
    font-size: 11px; font-family: var(--font-mono); color: var(--text-muted);
    background: var(--bg-overlay); padding: 2px 8px; border-radius: var(--radius-sm);
  }
  .header-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; }

  /* ── Tabs ──────────────────────────────────────────────────────────── */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-subtle); margin-bottom: 24px; }
  .tabs button {
    padding: 10px 20px; background: none; border: none;
    border-bottom: 2px solid transparent; cursor: pointer;
    font-size: 13px; color: var(--text-muted); font-weight: 500;
    margin-bottom: -1px; transition: all 0.15s;
  }
  .tabs button:hover { color: var(--text-primary); }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* ── Containers ────────────────────────────────────────────────────── */
  .containers-list { display: grid; gap: 16px; }
  .container-card {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg); padding: 18px; overflow: hidden;
  }
  .container-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: 12px; flex-wrap: wrap; gap: 8px;
  }
  .container-title { display: flex; align-items: center; gap: 10px; }
  .container-title h3 { font-size: 15px; font-weight: 600; margin: 0; color: var(--text-primary); }
  .container-actions { display: flex; gap: 6px; flex-wrap: wrap; }

  .container-meta {
    display: flex; gap: 20px; flex-wrap: wrap;
    background: var(--bg-overlay); border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 12px;
  }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta-value { font-size: 13px; color: var(--text-secondary); }

  /* Status badge */
  .status-badge {
    padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .status-badge.running { background: var(--green-subtle); color: var(--green-text); }
  .status-badge.exited, .status-badge.stopped { background: var(--red-subtle); color: var(--red-text); }
  .status-badge.created { background: var(--yellow-subtle); color: var(--yellow-text); }
  .status-badge.paused { background: var(--purple-subtle); color: var(--purple); }

  /* Action buttons */
  .btn-act {
    padding: 4px 10px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border-default); background: var(--bg-raised); color: var(--text-secondary);
    transition: all 0.15s;
  }
  .btn-act:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .btn-act:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-act.btn-start { color: var(--green-text); border-color: color-mix(in srgb, var(--green) 30%, transparent); background: var(--green-subtle); }
  .btn-act.btn-start:hover:not(:disabled) { background: color-mix(in srgb, var(--green) 20%, transparent); }
  .btn-act.btn-stop { color: var(--yellow-text); border-color: color-mix(in srgb, var(--yellow) 30%, transparent); background: var(--yellow-subtle); }
  .btn-act.btn-stop:hover:not(:disabled) { background: color-mix(in srgb, var(--yellow) 15%, transparent); }

  /* Header buttons */
  .btn-header {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    cursor: pointer; border: 1px solid transparent; white-space: nowrap;
    text-decoration: none; display: inline-flex; align-items: center; justify-content: center;
    line-height: 1; box-sizing: border-box; font-family: inherit; outline: none; transition: all 0.15s;
  }
  .btn-header.btn-success  { background: var(--green); color: var(--text-inverse); }
  .btn-header.btn-success:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-header.btn-redeploy { background: var(--bg-raised); color: var(--text-secondary); border: 1px solid var(--border-default); }
  .btn-header.btn-redeploy:hover:not(:disabled) { background: var(--bg-hover); }
  .btn-header.btn-secondary { background: var(--bg-raised); color: var(--text-secondary); border: 1px solid var(--border-default); }
  .btn-header.btn-secondary:hover { background: var(--bg-hover); }
  .btn-header.btn-danger { background: var(--red); color: var(--text-inverse); }
  .btn-header.btn-danger:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-header:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-primary {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    cursor: pointer; border: none; background: var(--accent); color: var(--text-inverse);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border-default); background: var(--bg-raised); color: var(--text-secondary);
  }
  .btn-secondary:hover { background: var(--bg-hover); }

  /* Image details */
  .image-details-toggle {
    background: none; border: none; font-size: 12px; color: var(--accent);
    cursor: pointer; padding: 4px 0; margin-bottom: 8px; font-weight: 500;
  }
  .image-details-toggle:hover { color: var(--accent-hover); }
  .image-details-panel {
    background: var(--bg-overlay); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 14px; margin-bottom: 14px; font-size: 13px;
  }
  .img-info-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px; margin-bottom: 12px;
  }
  .img-info-grid > div { display: flex; flex-direction: column; gap: 2px; }
  .img-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; }
  .img-section { margin-top: 12px; }
  .img-section-title {
    font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;
    letter-spacing: 0.05em; margin-bottom: 6px;
  }
  .img-note { font-size: 11px; color: var(--text-muted); font-style: italic; margin-top: 8px; }
  .history-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .history-table th {
    text-align: left; font-weight: 600; color: var(--text-muted); padding: 6px 8px;
    border-bottom: 1px solid var(--border-default); font-size: 10px; text-transform: uppercase;
  }
  .history-table td { padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; color: var(--text-secondary); }
  .layer-cmd { max-width: 500px; word-break: break-all; }
  .nowrap { white-space: nowrap; }

  /* ── Metrics ───────────────────────────────────────────────────────── */
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 20px; }
  .metrics-card {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg); padding: 20px;
  }
  .metrics-card h3 { font-size: 15px; font-weight: 600; margin: 0 0 16px; color: var(--text-primary); }
  .metric-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
  .metric-value { font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .metric-value.warn { color: var(--red-text); }

  /* Range bar */
  .range-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
  .range-label { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
  .range-btn {
    padding: 4px 12px; border: 1px solid var(--border-default); background: var(--bg-raised);
    border-radius: 16px; font-size: 12px; font-weight: 500; cursor: pointer; color: var(--text-muted);
    transition: all 0.15s;
  }
  .range-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .range-btn.active { background: var(--accent); color: var(--text-inverse); border-color: var(--accent); }
  .range-hint { font-size: 11px; color: var(--text-muted); margin-left: 8px; }

  /* Live snapshot */
  .live-snapshot {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px;
    background: var(--bg-overlay); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 12px;
  }
  .snap-item { display: flex; flex-direction: column; gap: 3px; }
  .snap-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; }
  .snap-value { font-size: 14px; font-weight: 700; color: var(--text-primary); }
  .snap-value.warn { color: var(--red-text); }
  .mini-bar { height: 4px; background: var(--border-default); border-radius: 2px; overflow: hidden; margin-top: 2px; }
  .mini-fill { height: 100%; border-radius: 2px; }
  .mini-fill.cpu { background: var(--blue); }
  .mini-fill.mem { background: var(--green); }

  /* Chart blocks */
  .chart-block { margin-bottom: 20px; }
  .chart-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .chart-svg { width: 100%; height: 80px; display: block; border-bottom: 1px solid var(--border-subtle); }
  .chart-times { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-top: 2px; }
  .legend { display: flex; gap: 12px; margin-top: 4px; font-size: 11px; }
  .legend-item { font-weight: 500; }

  /* No history */
  .no-history {
    background: var(--yellow-subtle); border: 1px solid color-mix(in srgb, var(--yellow) 30%, transparent);
    border-radius: var(--radius-md); padding: 16px; margin: 12px 0; font-size: 13px; color: var(--yellow-text);
  }
  .no-history p { margin: 0 0 4px; }

  /* ── Config tab ────────────────────────────────────────────────────── */
  .inspect-section {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 20px; margin-bottom: 14px;
  }
  .inspect-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .inspect-header h3 { font-size: 16px; font-weight: 650; color: var(--text-primary); margin: 0; }

  .btn-load {
    padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border-default); background: var(--bg-hover); color: var(--text-secondary);
  }
  .btn-load:hover { background: var(--bg-active); }

  .info-group { margin-bottom: 18px; }
  .info-group:last-child { margin-bottom: 0; }
  .info-group h4 {
    font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.05em; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);
  }

  .kv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px 20px; }
  .kv-grid.compact { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .kv { display: flex; flex-direction: column; gap: 1px; }
  .k { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .v { font-size: 13px; color: var(--text-secondary); word-break: break-all; }
  .v.mono, .mono { font-family: var(--font-mono); font-size: 12px; }

  .net-card {
    background: var(--bg-overlay); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 10px 14px; margin-bottom: 8px;
  }
  .net-name { font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 6px; display: block; }

  .mini-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .mini-table th {
    text-align: left; padding: 6px 10px; font-size: 10px; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
    background: var(--bg-overlay); border-bottom: 1px solid var(--border-default);
  }
  .mini-table td { padding: 6px 10px; border-top: 1px solid var(--border-subtle); color: var(--text-secondary); }

  .env-list {
    background: var(--bg-overlay); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 10px 14px; max-height: 200px; overflow-y: auto;
  }
  .env-line { font-size: 11px; color: var(--text-secondary); padding: 1px 0; }

  .label-key { color: var(--text-muted); font-size: 10px; word-break: break-all; }
  .label-val { color: var(--text-secondary); font-size: 11px; word-break: break-all; }

  /* ── Modal ─────────────────────────────────────────────────────────── */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-surface); padding: 28px; border-radius: var(--radius-lg);
    border: 1px solid var(--border-default); width: 100%; max-width: 420px; box-shadow: var(--shadow-md);
  }
  .modal h3 { margin: 0 0 6px; font-size: 16px; font-weight: 700; color: var(--text-primary); }
  .help-text { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: var(--text-secondary); }
  .form-group input {
    width: 100%; padding: 9px 12px; border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); font-size: 14px; box-sizing: border-box;
    background: var(--bg-input); color: var(--text-primary);
  }
  .form-group input:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-subtle); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

  /* ── Shared ────────────────────────────────────────────────────────── */
  .empty-state {
    padding: 48px; background: var(--bg-overlay); border-radius: var(--radius-lg);
    text-align: center; color: var(--text-muted);
  }
  .empty-state p { margin-bottom: 16px; }
  .small { font-size: 12px; }
  .loading-text { color: var(--text-muted); font-style: italic; font-size: 13px; }
  .error-text { color: var(--red-text); font-size: 13px; }

  .empty { color: var(--text-muted); font-style: italic; text-align: center; padding: 30px; }
  .loading { color: var(--text-muted); font-style: italic; font-size: 13px; }
  .error { color: var(--red-text); font-size: 13px; }
  .template-error {
    background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red);
    border-radius: var(--radius-sm); padding: 8px 12px; font-size: 13px; margin-bottom: 12px;
  }

  /* ── Deployments tab ──────────────────────────────────────────────── */
  .deployments-list {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg); overflow: hidden;
  }
  .deployments-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .deployments-table thead th {
    text-align: left; padding: 10px 14px; font-size: 10px; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
    background: var(--bg-overlay); border-bottom: 1px solid var(--border-default);
  }
  .deployments-table tbody td {
    padding: 10px 14px; border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary); vertical-align: middle;
  }
  .deployment-row:hover { background: var(--bg-hover); }
  .deployment-row.latest { background: color-mix(in srgb, var(--accent) 4%, transparent); }
  .deployment-row.latest:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }

  .version-cell { display: flex; align-items: center; gap: 8px; }
  .version-number { font-weight: 700; color: var(--text-primary); font-family: var(--font-mono); font-size: 13px; }
  .current-badge {
    padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 600;
    background: var(--accent-subtle); color: var(--accent); text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .image-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }

  .deploy-status-badge {
    padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.03em; display: inline-block;
  }
  .deploy-status-badge.succeeded { background: var(--green-subtle); color: var(--green-text); }
  .deploy-status-badge.failed { background: var(--red-subtle); color: var(--red-text); }
  .deploy-status-badge.pending { background: var(--yellow-subtle); color: var(--yellow-text); }
  .deploy-status-badge.running { background: var(--blue-subtle); color: var(--blue-text); }
  .deploy-status-badge.rolled_back { background: var(--purple-subtle); color: var(--purple); }

  .btn-rollback {
    color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    background: var(--accent-subtle);
  }
  .btn-rollback:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 15%, transparent); }

  .btn-error-detail {
    color: var(--red-text); border-color: color-mix(in srgb, var(--red) 30%, transparent);
    background: var(--red-subtle); margin-left: 4px;
  }
  .btn-error-detail:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 15%, transparent); }

  .text-muted { color: var(--text-muted); }

  /* ── Webhook ──────────────────────────────────────────────────────── */
  .webhook-section {
    margin-bottom: 20px;
  }
  .webhook-toggle {
    background: none; border: none; font-size: 13px; color: var(--accent);
    cursor: pointer; padding: 6px 0; font-weight: 600; display: flex; align-items: center; gap: 6px;
  }
  .webhook-toggle:hover { color: var(--accent-hover); }
  .webhook-active-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block;
  }
  .webhook-panel {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 16px; margin-top: 6px;
  }
  .webhook-info { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
  .webhook-url-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .webhook-label {
    font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; min-width: 90px;
  }
  .webhook-url {
    font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);
    background: var(--bg-overlay); padding: 4px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); word-break: break-all;
  }
  .webhook-meta { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }
  .webhook-empty { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }
  .webhook-actions { display: flex; gap: 8px; margin-top: 12px; }
  .btn-copy {
    color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    background: var(--accent-subtle); white-space: nowrap;
  }
  .btn-copy:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 15%, transparent); }

  /* Token alert */
  .webhook-token-alert {
    background: var(--yellow-subtle); border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent);
    border-radius: var(--radius-md); padding: 14px; margin: 12px 0;
  }
  .token-warning {
    font-size: 13px; font-weight: 600; color: var(--yellow-text); margin: 0 0 10px;
  }
  .token-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .token-value {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-primary);
    background: var(--bg-surface); padding: 6px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-default); word-break: break-all; flex: 1; min-width: 0;
  }
  .webhook-usage { margin-top: 12px; }
  .usage-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); margin: 0 0 4px; }
  .usage-cmd {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);
    display: block; white-space: pre-wrap; word-break: break-all;
  }

  /* ── Health indicator ─────────────────────────────────────────────── */
  .health-indicator {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    vertical-align: middle;
    margin-left: 4px;
  }
  .health-healthy {
    background: var(--green);
    box-shadow: 0 0 4px color-mix(in srgb, var(--green) 50%, transparent);
  }
  .health-unhealthy {
    background: var(--red);
    box-shadow: 0 0 4px color-mix(in srgb, var(--red) 50%, transparent);
  }
  .health-starting {
    background: var(--yellow);
    box-shadow: 0 0 4px color-mix(in srgb, var(--yellow) 50%, transparent);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .health-none {
    width: auto;
    height: auto;
    border-radius: 0;
    background: none;
    box-shadow: none;
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* ── Scale hint ───────────────────────────────────────────────────── */
  .scale-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 6px;
  }
</style>
