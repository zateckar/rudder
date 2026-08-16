<script lang="ts">
  import { onMount } from 'svelte';
  import SshKeyPrompt from '$lib/components/SshKeyPrompt.svelte';

  let { data } = $props();

  let activeTab = $state<'overview' | 'metrics' | 'events' | 'containers' | 'images' | 'networks' | 'traefik' | 'crowdsec' | 'terminal' | 'settings'>('overview');
  let systemInfo = $state<any>(null);
  let loadingInfo = $state(false);

  // SSH key held in memory for terminal session (never persisted server-side)
  let terminalSshKey = $state('');
  let showTerminalKeyPrompt = $state(false);
  let showSyslogKeyPrompt = $state(false);

  // Sync SSH key with sessionStorage to persist across reloads during session
  onMount(() => {
    const saved = sessionStorage.getItem(`rudder:ssh-key:${workerId}`);
    if (saved) terminalSshKey = saved;
  });

  $effect(() => {
    if (terminalSshKey) {
      sessionStorage.setItem(`rudder:ssh-key:${workerId}`, terminalSshKey);
    } else {
      sessionStorage.removeItem(`rudder:ssh-key:${workerId}`);
    }
  });

  let events = $state<any[]>([]);
  let allSyslogEvents = $state<any[]>([]);
  let syslogMessage = $state('');
  let eventsLoading = $state(false);
  let eventFilter = $state('');
  let eventSince = $state('24h');
  let eventSource = $state<'podman' | 'syslog'>('podman');
  let syslogSeverity = $state('');
  let eventPage = $state(0);
  const EVENTS_PER_PAGE = 250;

  let pruning = $state(false);
  let collectMsg = $state('');
  let provisioning = $state(false);
  let provisionMsg = $state('');
  let showProvisionModal = $state(false);
  /**
   * On by default: re-provisioning should patch. Off is for environments with
   * their own patch pipeline, and for runs where the extra minutes matter — the
   * pending count is still reported either way.
   */
  let applyUpdates = $state(true);

  let metricsClient = $state<any[] | null>(null);
  let metricsLoading = $state(false);
  let metricsPeriod = $state('24');

  let traefik = $state<any>(null);
  let traefikLoading = $state(false);

  let crowdsec = $state<any>(null);
  let crowdsecLoading = $state(false);

  let terminalReady = $state(false);

  // ── OIDC Settings state ──────────────────────────────────────────
  let oidcEnabled = $state(false);
  let oidcProviderUrl = $state('');
  let oidcClientId = $state('');
  let oidcClientSecret = $state('');
  let oidcClientSecretSet = $state(false);
  let oidcEncryptionKeySet = $state(false);
  let oidcAppliedAt = $state<string | null>(null);
  // Shared callback host/URL, resolved server-side so the UI and the generated
  // Traefik config can never disagree about what to register with the IdP.
  let oidcCallbackHost = $state('');
  let oidcCallbackUrl = $state('');
  let oidcSaving = $state(false);
  let oidcSaveMsg = $state('');
  let oidcLoaded = $state(false);
  let showOidcApplyPrompt = $state(false);
  let oidcApplying = $state(false);
  let oidcApplyMsg = $state('');

  // ── Routing mode ─────────────────────────────────────────────────
  // The server value is the source of truth; the override holds the answer
  // from the switch endpoint until the page is reloaded.
  let routingOverride = $state<'labels' | 'http' | null>(null);
  let routingFetchCleared = $state(false);
  const routingMode = $derived(routingOverride ?? data.worker.routingMode ?? 'labels');
  const configFetchedAt = $derived(
    routingFetchCleared ? null : (data.worker.configFetchedAt ?? null),
  );
  let routingSaving = $state(false);
  let routingMsg = $state('');

  // Images tab state
  let images = $state<any[]>([]);
  let imagesLoading = $state(false);
  let imagesLoaded = $state(false);
  let imagePullName = $state('');
  let imagePulling = $state(false);
  let imagePullError = $state('');
  let showPullForm = $state(false);
  let imageDeleting = $state<string | null>(null);

  // Networks tab state
  let networks = $state<any[]>([]);
  let networksLoading = $state(false);
  let networksLoaded = $state(false);
  let networkCreateName = $state('');
  let networkCreateDriver = $state('bridge');
  let networkCreating = $state(false);
  let networkCreateError = $state('');
  let showNetworkForm = $state(false);
  let networkDeleting = $state<string | null>(null);

  let workerId = $derived(data.worker.id);

  // ── Tab data loaders ─────────────────────────────────────────────────
  async function loadSystemInfo() {
    loadingInfo = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/info`, { method: 'POST' });
      systemInfo = await res.json();
    } catch (e: any) {
      systemInfo = { error: e.message };
    } finally {
      loadingInfo = false;
    }
  }

  async function loadEvents() {
    eventsLoading = true;
    eventPage = 0;
    try {
      if (eventSource === 'syslog') {
        const sinceMap: Record<string, string> = {
          '1h': '1 hour ago',
          '6h': '6 hours ago',
          '24h': '24 hours ago',
          '7d': '7 days ago',
        };
        const sinceStr = sinceMap[eventSince] || '24 hours ago';
        const sp = new URLSearchParams({ since: sinceStr, lines: '1000' });
        const res = await fetch(`/api/workers/${workerId}/syslog?${sp}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshPrivateKey: terminalSshKey })
        });
        const body = await res.json();
        allSyslogEvents = body.events || [];
        syslogMessage = body.message || '';
        applySyslogFilter();
      } else {
        const sinceMap: Record<string, string> = {
          '1h': new Date(Date.now() - 3600_000).toISOString(),
          '6h': new Date(Date.now() - 6 * 3600_000).toISOString(),
          '24h': new Date(Date.now() - 24 * 3600_000).toISOString(),
          '7d': new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
        };
        const sp = new URLSearchParams({ since: sinceMap[eventSince] || sinceMap['24h'] });
        if (eventFilter) sp.append('type', eventFilter);
        const res = await fetch(`/api/workers/${workerId}/events?${sp}`);
        const body = await res.json();
        events = body.events || [];
        syslogMessage = '';
        allSyslogEvents = [];
      }
    } catch {
      events = [];
      allSyslogEvents = [];
    } finally {
      eventsLoading = false;
    }
  }

  function applySyslogFilter() {
    let filtered = allSyslogEvents;
    if (syslogSeverity) {
      filtered = filtered.filter(e => e.priority === syslogSeverity);
    }
    events = filtered.slice(0, (eventPage + 1) * EVENTS_PER_PAGE);
  }

  function nextEventPage() {
    eventPage++;
    applySyslogFilter();
  }

  function prevEventPage() {
    if (eventPage > 0) { eventPage--; applySyslogFilter(); }
  }

  async function loadMetrics() {
    metricsLoading = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/metrics?hours=${metricsPeriod}`);
      metricsClient = await res.json();
    } catch { metricsClient = []; }
    finally { metricsLoading = false; }
  }

  async function loadTraefik() {
    traefikLoading = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/traefik?tail=200`);
      traefik = await res.json();
    } catch (e: any) {
      traefik = { error: e.message };
    } finally {
      traefikLoading = false;
    }
  }

  async function loadCrowdsec() {
    crowdsecLoading = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/crowdsec?tail=200`);
      crowdsec = await res.json();
    } catch (e: any) {
      crowdsec = { error: e.message };
    } finally {
      crowdsecLoading = false;
    }
  }

  async function loadImages() {
    imagesLoading = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/images`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      images = body.images || [];
      imagesLoaded = true;
    } catch (e: any) {
      images = [];
    } finally {
      imagesLoading = false;
    }
  }

  async function pullImage() {
    const name = imagePullName.trim();
    if (!name) return;
    imagePulling = true;
    imagePullError = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Pull failed');
      imagePullName = '';
      showPullForm = false;
      await loadImages();
    } catch (e: any) {
      imagePullError = e.message;
    } finally {
      imagePulling = false;
    }
  }

  async function deleteImage(imageId: string) {
    if (!confirm('Delete this image? This cannot be undone.')) return;
    imageDeleting = imageId;
    try {
      const res = await fetch(`/api/workers/${workerId}/images?image=${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      await loadImages();
    } catch (e: any) {
      alert(e.message);
    } finally {
      imageDeleting = null;
    }
  }

  async function loadNetworks() {
    networksLoading = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/networks`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      networks = body.networks || [];
      networksLoaded = true;
    } catch (e: any) {
      networks = [];
    } finally {
      networksLoading = false;
    }
  }

  async function createNetwork() {
    const name = networkCreateName.trim();
    if (!name) return;
    networkCreating = true;
    networkCreateError = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/networks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, driver: networkCreateDriver }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Create failed');
      networkCreateName = '';
      networkCreateDriver = 'bridge';
      showNetworkForm = false;
      await loadNetworks();
    } catch (e: any) {
      networkCreateError = e.message;
    } finally {
      networkCreating = false;
    }
  }

  async function deleteNetwork(networkName: string) {
    if (!confirm(`Delete network "${networkName}"? This cannot be undone.`)) return;
    networkDeleting = networkName;
    try {
      const res = await fetch(`/api/workers/${workerId}/networks?name=${encodeURIComponent(networkName)}`, {
        method: 'DELETE',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      await loadNetworks();
    } catch (e: any) {
      alert(e.message);
    } finally {
      networkDeleting = null;
    }
  }

  const DEFAULT_NETWORKS = ['podman', 'bridge', 'host', 'none'];

  const totalImageSize = $derived(images.reduce((sum, img) => sum + (img.size || 0), 0));

  function switchTab(tab: typeof activeTab) {
    // Destroy terminal when leaving its tab so it can be recreated fresh on return
    if (activeTab === 'terminal' && tab !== 'terminal' && termInstance) {
      termInstance.dispose();
      termInstance = null;
      termFit = null;
      terminalReady = false;
    }
    activeTab = tab;
    if (tab === 'overview' && !systemInfo && !loadingInfo) loadSystemInfo();
    if (tab === 'events' && !eventsLoading) loadEvents();
    if (tab === 'metrics' && !metricsLoading) loadMetrics();
    if (tab === 'images' && !imagesLoaded && !imagesLoading) loadImages();
    if (tab === 'networks' && !networksLoaded && !networksLoading) loadNetworks();
    if (tab === 'traefik' && !traefikLoading) loadTraefik();
    if (tab === 'crowdsec' && !crowdsecLoading) loadCrowdsec();
    if (tab === 'settings' && !oidcLoaded) loadOidcSettings();
    if (tab === 'terminal') {
      if (terminalSshKey) {
        initTerminal();
      } else {
        showTerminalKeyPrompt = true;
      }
    }
  }

  onMount(() => {
    loadSystemInfo();
  });

  async function collectMetrics() {
    collectMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/collect`, { method: 'POST' });
      const body = await res.json();
      if (body.success) {
        collectMsg = body.collected ? 'Metrics collected' : 'Worker offline';
        setTimeout(() => window.location.reload(), 1500);
      } else {
        collectMsg = body.error || 'Failed';
      }
    } catch (e: any) {
      collectMsg = e.message;
    }
  }

  function requestProvision() {
    showProvisionModal = true;
  }

  async function provisionWorker(sshKey: string) {
    showProvisionModal = false;
    provisioning = true;
    provisionMsg = '';
    try {
      const res = await fetch('/api/workers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId, sshPrivateKey: sshKey, applyUpdates }),
      });
      const body = await res.json();
      if (body.success) {
        provisionMsg = 'Provisioned!';
        setTimeout(() => window.location.reload(), 1500);
      } else {
        provisionMsg = body.error || 'Failed';
      }
    } catch (e: any) {
      provisionMsg = e.message;
    } finally {
      provisioning = false;
    }
  }

  async function pruneSystem() {
    if (!confirm('Prune unused images, containers, volumes, and networks?')) return;
    pruning = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/prune`, { method: 'POST' });
      const body = await res.json();
      if (body.success) {
        alert('Prune completed');
        window.location.reload();
      } else {
        alert(body.error || 'Prune failed');
      }
    } finally {
      pruning = false;
    }
  }

  // ── OIDC Settings functions ────────────────────────────────
  async function loadOidcSettings() {
    if (oidcLoaded) return;
    try {
      const res = await fetch(`/api/workers/${workerId}/oidc`);
      const body = await res.json();
      oidcEnabled = body.oidcEnabled ?? false;
      oidcProviderUrl = body.oidcProviderUrl ?? '';
      oidcClientId = body.oidcClientId ?? '';
      oidcClientSecretSet = body.oidcClientSecretSet ?? false;
      oidcEncryptionKeySet = body.oidcEncryptionKeySet ?? false;
      oidcAppliedAt = body.oidcAppliedAt ?? null;
      oidcCallbackHost = body.callbackHost ?? '';
      oidcCallbackUrl = body.callbackUrl ?? '';
      oidcLoaded = true;
    } catch { /* ignore */ }
  }

  async function saveOidcSettings() {
    oidcSaving = true;
    oidcSaveMsg = '';
    try {
      const payload: Record<string, any> = { oidcEnabled, oidcProviderUrl, oidcClientId };
      if (oidcClientSecret) payload.oidcClientSecret = oidcClientSecret;
      const res = await fetch(`/api/workers/${workerId}/oidc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      oidcClientSecretSet = data.oidcClientSecretSet;
      oidcEncryptionKeySet = data.oidcEncryptionKeySet;
      oidcAppliedAt = data.oidcAppliedAt ?? null;
      oidcCallbackHost = data.callbackHost ?? oidcCallbackHost;
      oidcCallbackUrl = data.callbackUrl ?? oidcCallbackUrl;
      oidcClientSecret = '';
      oidcSaveMsg = routingMode === 'http'
        ? 'Saved. The worker picks this up on its next fetch — within about ten seconds.'
        : 'Saved. Now click “Apply to Traefik” — deployments stay blocked until the config reaches the worker.';
    } catch (e: any) {
      oidcSaveMsg = 'Error: ' + e.message;
    } finally {
      oidcSaving = false;
    }
  }

  async function applyOidcToTraefik(sshKey: string) {
    showOidcApplyPrompt = false;
    oidcApplying = true;
    oidcApplyMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/oidc/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sshPrivateKey: sshKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Apply failed');
      oidcApplyMsg = data.message || 'Applied successfully.';
      oidcAppliedAt = new Date().toISOString();
    } catch (e: any) {
      oidcApplyMsg = 'Error: ' + e.message;
    } finally {
      oidcApplying = false;
    }
  }

  async function setRoutingMode(mode: 'labels' | 'http') {
    routingSaving = true;
    routingMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/routing-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routingMode: mode }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Switch failed');
      routingOverride = body.routingMode;
      routingFetchCleared = true;
      routingMsg = body.message;
    } catch (e: any) {
      routingMsg = 'Error: ' + e.message;
    } finally {
      routingSaving = false;
    }
  }

  async function clearOidcSettings() {
    if (!confirm('Remove all OIDC configuration from this worker? Applications set to "Default" auth will become public.')) return;
    try {
      const res = await fetch(`/api/workers/${workerId}/oidc`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
      oidcEnabled = false;
      oidcProviderUrl = '';
      oidcClientId = '';
      oidcClientSecret = '';
      oidcClientSecretSet = false;
      oidcEncryptionKeySet = false;
      oidcAppliedAt = null;
      oidcSaveMsg = 'OIDC configuration cleared.';
    } catch (e: any) {
      oidcSaveMsg = 'Error: ' + e.message;
    }
  }


  async function deleteWorker() {
    if (!confirm(`Delete worker "${data.worker.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/workers/${workerId}`, { method: 'DELETE' });
      const body = await res.json();
      if (res.ok) {
        window.location.href = '/workers';
      } else {
        alert(body.error || 'Delete failed');
      }
    } catch (e: any) {
      alert(e.message);
    }
  }

  // ── Host terminal (xterm over HTTP) ───────────────────────────────
  let termEl: HTMLElement | undefined = $state();
  let termInstance: any = null;
  let termFit: any = null;
  let termError = $state('');
  let termConnecting = $state(false);
  let termCmd = $state('');
  let termHistory: string[] = [];
  let termHistIdx = -1;

  async function initTerminal() {
    if (termInstance) return;
    termConnecting = true;
    termError = '';
    try {
      const [xtermMod, fitMod] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');

      const Terminal = xtermMod.default?.Terminal || xtermMod.Terminal;
      const FitAddon = fitMod.default?.FitAddon || fitMod.FitAddon;

      termInstance = new Terminal({
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
        theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff' },
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 2000,
        convertEol: true,
      });
      termFit = new FitAddon();
      termInstance.loadAddon(termFit);

      // Show the terminal div first, then open xterm so it can measure real dimensions
      termConnecting = false;
      terminalReady = true;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!termEl) return; // tab switched away during async load
      termInstance.open(termEl);
      termFit.fit();

      termInstance.write(`\x1b[1;32m${data.worker.name}\x1b[0m — Host Terminal\r\n`);
      termInstance.write('Type commands and press Enter. Ctrl+L to clear.\r\n\r\n');
      showPrompt();

      termInstance.onData((d: string) => {
        if (d === '\r') {
          runTermCmd();
        } else if (d === '\x7f' || d === '\b') {
          if (termCmd.length > 0) {
            termCmd = termCmd.slice(0, -1);
            termInstance.write('\b \b');
          }
        } else if (d === '\x03') {
          termInstance.write('^C\r\n');
          termCmd = '';
          showPrompt();
        } else if (d === '\x0c') {
          termInstance.write('\x1b[2J\x1b[H');
          termCmd = '';
          showPrompt();
        } else if (d === '\x1b[A') {
          if (termHistory.length > 0 && termHistIdx < termHistory.length - 1) {
            termHistIdx++;
            termCmd = termHistory[termHistory.length - 1 - termHistIdx];
            clearLine();
            termInstance.write(termCmd);
          }
        } else if (d === '\x1b[B') {
          if (termHistIdx > 0) {
            termHistIdx--;
            termCmd = termHistory[termHistory.length - 1 - termHistIdx];
            clearLine();
            termInstance.write(termCmd);
          } else if (termHistIdx === 0) {
            termHistIdx = -1;
            termCmd = '';
            clearLine();
          }
        } else if (d >= ' ') {
          termCmd += d;
          termInstance.write(d);
        }
      });

      window.addEventListener('resize', () => termFit?.fit());
    } catch (e: any) {
      termError = e.message || 'Terminal init failed';
      termConnecting = false;
    }
  }

  function clearLine() {
    termInstance.write('\x1b[2K\r');
    showPrompt();
  }

  function showPrompt() {
    termInstance.write('$ ');
  }

  async function runTermCmd() {
    const cmd = termCmd.trim();
    termInstance.write('\r\n');
    termCmd = '';
    termHistIdx = -1;

    if (!cmd) { showPrompt(); return; }
    termHistory.push(cmd);
    if (termHistory.length > 200) termHistory.shift();

    if (cmd === 'clear') {
      termInstance.write('\x1b[2J\x1b[H');
      showPrompt();
      return;
    }

    try {
      const res = await fetch(`/api/workers/${workerId}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, sshPrivateKey: terminalSshKey }),
      });
      const body = await res.json();
      if (body.error) {
        termInstance.write(`\x1b[31m${body.error}\x1b[0m\r\n`);
      } else {
        if (body.stdout) termInstance.write(body.stdout.replace(/\n/g, '\r\n'));
        if (body.stderr) termInstance.write(`\x1b[31m${body.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
      }
    } catch (e: any) {
      termInstance.write(`\x1b[31mError: ${e.message}\x1b[0m\r\n`);
    }
    showPrompt();
  }

  function formatBytes(bytes: number | null | undefined): string {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatUptime(value: number | string | null | undefined): string {
    if (!value) return '—';
    // If it's a string from Podman (e.g. "up 45 days, 2 hours, 30 minutes"), return as-is
    if (typeof value === 'string') return value;
    // If it's seconds, format it
    const seconds = value;
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 60)}m`;
  }

  function timeAgo(dateStr: string): string {
    const d = new Date(dateStr);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  // SVG sparkline
  function sparkline(values: (number | null)[], width = 300, height = 48, color = '#0066cc'): string {
    const nums = values.filter((v): v is number => v != null && !isNaN(v));
    if (nums.length < 2) return '';
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const range = max - min || 1;
    const step = width / (nums.length - 1);
    const pts = nums.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 4) - 2}`).join(' ');
    const area = pts + ` ${width},${height} 0,${height}`;
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
      <polygon points="${area}" fill="${color}15" />
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />
    </svg>`;
  }

  // Chart component for multiple series
  function chart(
    series: { values: (number | null)[]; color: string; label: string }[],
    width = 600,
    height = 120,
    unit = ''
  ): string {
    const allNums = series.flatMap(s => s.values.filter((v): v is number => v != null && !isNaN(v)));
    if (allNums.length < 2) return '<p class="chart-empty">No data collected yet</p>';
    const min = 0;
    const max = Math.max(...allNums) * 1.1 || 1;
    const labels: string[] = [];
    let paths = '';

    for (const s of series) {
      const nums = s.values.filter((v): v is number => v != null && !isNaN(v));
      if (nums.length < 2) continue;
      const step = width / (nums.length - 1);
      const pts = nums.map((v, i) => `${i * step},${height - ((v - min) / (max - min)) * (height - 16) - 8}`).join(' ');
      paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.5" />`;
      labels.push(`<span style="color:${s.color}">${s.label}: ${nums[nums.length - 1] != null ? (unit === '%' ? nums[nums.length - 1].toFixed(1) + '%' : formatBytes(nums[nums.length - 1])) : '—'}</span>`);
    }

    // Grid lines
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const y = 8 + (i / 4) * (height - 16);
      const val = max - (i / 4) * max;
      grid += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#303744" stroke-width="0.5" />`;
      grid += `<text x="${width + 4}" y="${y + 3}" fill="#7a8494" font-size="9">${unit === '%' ? val.toFixed(0) + '%' : formatBytes(val)}</text>`;
    }

    return `<div class="chart-container">
      <svg viewBox="0 0 ${width + 50} ${height}" width="100%" height="${height}">${grid}${paths}</svg>
      <div class="chart-legend">${labels.join('')}</div>
    </div>`;
  }

  // Availability timeline — aggregate pings into time buckets
  function availabilityBar(pings: any[], width = 600, height = 28): string {
    if (pings.length === 0) return '';

    const BUCKETS = 48; // 30-min buckets for 24h
    const now = Date.now();
    const windowStart = now - 24 * 3600 * 1000;
    const span = 24 * 3600 * 1000; // fixed 24-hour window

    // Assign each ping to a bucket
    const buckets: Array<{ online: number; offline: number; total: number }> = [];
    for (let i = 0; i < BUCKETS; i++) buckets.push({ online: 0, offline: 0, total: 0 });

    for (const p of pings) {
      const ts = new Date(p.pingedAt).getTime();
      const idx = Math.floor((ts - windowStart) / (span / BUCKETS));
      if (idx >= 0 && idx < BUCKETS) {
        if (p.status === 'online') buckets[idx].online++;
        else buckets[idx].offline++;
        buckets[idx].total++;
      }
    }

    const gap = 2;
    const barW = (width - (BUCKETS - 1) * gap) / BUCKETS;
    let rects = '';
    for (let i = 0; i < BUCKETS; i++) {
      const b = buckets[i];
      let fill: string;
      if (b.total === 0) {
        fill = 'var(--bg-overlay, #2d333b)';
      } else if (b.offline === 0) {
        fill = '#3fb950';
      } else if (b.online === 0) {
        fill = '#f85149';
      } else {
        fill = '#d29922'; // mixed — partial outage
      }
      const x = i * (barW + gap);
      rects += `<rect x="${x}" y="0" width="${barW}" height="${height}" rx="2" fill="${fill}" />`;
    }

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" class="avail-bar">${rects}</svg>`;
  }

</script>

{#snippet provisionOptions()}
  <label class="provision-option">
    <input type="checkbox" bind:checked={applyUpdates} />
    <span>
      Install pending host security updates
      <em>
        Re-provisioning is otherwise not a patching event — it refreshes configuration and container
        images but leaves the host's packages where they are. Adds a few minutes. Never reboots.
      </em>
    </span>
  </label>
{/snippet}

{#if showProvisionModal}
<SshKeyPrompt
  workerId={workerId}
  title="Provision Worker"
  description="Paste the SSH private key for root access. This key is used only for this provisioning session and is <strong>never stored</strong> on the server."
  submitLabel="Start Provisioning"
  onsubmit={provisionWorker}
  oncancel={() => showProvisionModal = false}
  extra={provisionOptions}
/>
{/if}

{#if showSyslogKeyPrompt}
<SshKeyPrompt
  workerId={workerId}
  title="SSH Key for System Logs"
  description="Paste the SSH private key to fetch system logs. The key is held in memory for this session only and is <strong>never stored</strong> on the server."
  submitLabel="Fetch Logs"
  onsubmit={(key) => {
    terminalSshKey = key;
    showSyslogKeyPrompt = false;
    loadEvents();
  }}
  oncancel={() => showSyslogKeyPrompt = false}
/>
{/if}

<div class="page">
  <div class="header">
    <div class="header-top">
      <a href="/workers" class="back-link">&larr; Workers</a>
      <div class="header-actions">
        <button class="btn-tiny btn-accent" disabled={provisioning} onclick={requestProvision} title="Re-run provisioning script on this worker (reinstalls Podman, Traefik, CrowdSec)">
          {provisioning ? 'Re-provisioning…' : (provisionMsg || 'Re-provision')}
        </button>
        <button class="btn-tiny" onclick={collectMetrics} title="Manually collect worker and container metrics">{collectMsg || 'Collect Now'}</button>
        <a href="/workers/{data.worker.id}/edit" class="btn-tiny" title="Edit worker configuration">Edit</a>
        <button class="btn-tiny btn-prune" disabled={pruning} onclick={pruneSystem} title="Prune unused images, containers, volumes, and networks">
          {pruning ? 'Pruning…' : 'Prune'}
        </button>
        <button class="btn-tiny btn-delete" onclick={deleteWorker} title="Delete this worker">Delete</button>
      </div>
    </div>
    <div class="title-row">
      <h1>{data.worker.name}</h1>
      <span class="status-badge {data.worker.status}">{data.worker.status}</span>
    </div>
    <div class="meta-row">
      <span class="meta">{data.worker.hostname}:{data.worker.sshPort}</span>
      {#if data.worker.baseDomain}
        <span class="meta mono">*.{data.worker.baseDomain}</span>
      {/if}
    </div>
  </div>

  <!-- Quick stats -->
  <div class="stat-row">
    <div class="stat">
      <div class="stat-value">{data.uptimePercent ?? '—'}{#if data.uptimePercent != null}%{/if}</div>
      <div class="stat-label">Uptime (24h)</div>
    </div>
    <div class="stat">
      <div class="stat-value">{data.avgLatency ?? '—'}{#if data.avgLatency != null}ms{/if}</div>
      <div class="stat-label">Avg Latency</div>
    </div>
    <div class="stat">
      <div class="stat-value">{data.containers.length}</div>
      <div class="stat-label">Managed</div>
    </div>
    <div class="stat">
      <div class="stat-value">{data.metrics.length > 0 ? timeAgo(data.metrics[0]?.collectedAt) : '—'}</div>
      <div class="stat-label">Last Collect</div>
    </div>
  </div>

  <!-- Availability bar -->
  {#if data.pings.length > 0}
    <div class="section">
      <div class="section-header">
        <h3>Availability · {data.uptimePercent != null ? data.uptimePercent + '%' : '—'}</h3>
        <span class="section-hint">
          {data.avgLatency != null ? `avg ${data.avgLatency}ms · ` : ''}Last 24 hours · 30-min windows
        </span>
      </div>
      {@html availabilityBar(data.pings)}
      <div class="avail-legend">
        <span class="avail-legend-item"><span class="avail-dot online"></span>Online</span>
        <span class="avail-legend-item"><span class="avail-dot mixed"></span>Partial</span>
        <span class="avail-legend-item"><span class="avail-dot offline"></span>Offline</span>
        <span class="avail-legend-item"><span class="avail-dot nodata"></span>No data</span>
      </div>
    </div>
  {/if}

  <!-- Metrics sparklines -->
  {#if data.metrics.length > 1}
    <div class="metrics-strip">
      <div class="metric-card">
        <div class="metric-label">CPU</div>
        {@html sparkline(data.metrics.map(m => m.cpuPercent), 200, 40, '#58a6ff')}
        <div class="metric-value">{data.metrics[0]?.cpuPercent?.toFixed(1) ?? '—'}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Memory</div>
        {@html sparkline(data.metrics.map(m => m.memPercent), 200, 40, '#3fb950')}
        <div class="metric-value">{data.metrics[0]?.memPercent?.toFixed(1) ?? '—'}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Running</div>
        {@html sparkline(data.metrics.map(m => m.containersRunning), 200, 40, '#38bdf8')}
        <div class="metric-value">{data.metrics[0]?.containersRunning ?? '—'}</div>
      </div>
    </div>
  {/if}

  <!-- Tabs -->
  <div class="tabs">
    <button class:active={activeTab === 'overview'} onclick={() => switchTab('overview')} title="Worker overview and system info">Overview</button>
    <button class:active={activeTab === 'metrics'} onclick={() => switchTab('metrics')} title="CPU, memory, disk metrics">Metrics</button>
    <button class:active={activeTab === 'events'} onclick={() => switchTab('events')} title="Podman and syslog events">Events</button>
    <button class:active={activeTab === 'containers'} onclick={() => activeTab = 'containers'} title="Containers on this worker">Containers ({data.containers.length})</button>
    <button class:active={activeTab === 'images'} onclick={() => switchTab('images')} title="Images on this worker">Images</button>
    <button class:active={activeTab === 'networks'} onclick={() => switchTab('networks')} title="Networks on this worker">Networks</button>
    <button class:active={activeTab === 'traefik'} onclick={() => switchTab('traefik')} title="Traefik reverse proxy">Traefik</button>
    <button class:active={activeTab === 'crowdsec'} onclick={() => switchTab('crowdsec')} title="CrowdSec WAF and IPS">CrowdSec</button>
    <button class:active={activeTab === 'terminal'} onclick={() => switchTab('terminal')} title="Interactive host terminal">Terminal</button>
    <button class:active={activeTab === 'settings'} onclick={() => switchTab('settings')} title="Worker settings and OIDC">Settings</button>
  </div>

  <!-- Overview tab -->
  {#if activeTab === 'overview'}
    <div class="section">
      <h3>Worker Configuration</h3>
      <div class="config-grid">
        <div class="cfg"><span class="cfg-label">Hostname</span><span class="cfg-value">{data.worker.hostname}</span></div>
        <div class="cfg"><span class="cfg-label">SSH Port</span><span class="cfg-value">{data.worker.sshPort}</span></div>
        <div class="cfg"><span class="cfg-label">SSH User</span><span class="cfg-value">{data.worker.sshUser}</span></div>
        <div class="cfg"><span class="cfg-label">Base Domain</span><span class="cfg-value mono">{data.worker.baseDomain ?? '—'}</span></div>
        <div class="cfg"><span class="cfg-label">Podman API</span><span class="cfg-value mono">{data.worker.podmanApiUrl}</span></div>
        <div class="cfg"><span class="cfg-label">Last Seen</span><span class="cfg-value">{data.worker.lastSeenAt ? new Date(data.worker.lastSeenAt).toLocaleString() : 'Never'}</span></div>
      </div>
    </div>

    <!-- Patching and platform versions.
         Nothing else in the UI answers "is this host patched?" or "would
         re-provisioning move Traefik?", and both are invisible from the
         container list. -->
    {#if systemInfo?.patch || systemInfo?.platform?.length}
      <div class="section">
        <h3>Patching &amp; Platform</h3>
        <div class="config-grid">
          <div class="cfg">
            <span class="cfg-label">Security updates pending</span>
            <span class="cfg-value">
              {#if systemInfo.patch?.updatesSecurity == null}
                <span class="patch-unknown" title="This worker has never reported a patch scan. Re-provision to install the daily scan.">not reported</span>
              {:else if systemInfo.patch.updatesSecurity > 0}
                <span class="patch-warn">{systemInfo.patch.updatesSecurity}</span>
              {:else}
                0
              {/if}
            </span>
          </div>
          <div class="cfg">
            <span class="cfg-label">All updates pending</span>
            <span class="cfg-value">
              {systemInfo.patch?.updatesPending ?? '—'}
            </span>
          </div>
          <div class="cfg">
            <span class="cfg-label">Reboot required</span>
            <span class="cfg-value">
              {#if systemInfo.patch?.rebootRequired == null}
                <span class="patch-unknown">not reported</span>
              {:else if systemInfo.patch.rebootRequired}
                <span class="patch-warn" title="Rudder never reboots a worker — applications are running here.">yes</span>
              {:else}
                no
              {/if}
            </span>
          </div>
          {#each systemInfo.platform ?? [] as comp (comp.component)}
            <div class="cfg">
              <span class="cfg-label">{comp.component}</span>
              <span class="cfg-value">
                {comp.runningVersion ?? 'unknown'}
                {#if comp.upToDate === false}
                  <span class="patch-warn" title={`Re-provisioning would install ${comp.expectedImage}`}>
                    → {comp.expectedVersion}
                  </span>
                {:else if comp.upToDate === null}
                  <span class="patch-unknown" title={`This control plane installs ${comp.expectedImage}`}>version unknown</span>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if loadingInfo}
      <div class="section"><p class="loading">Fetching system info…</p></div>
    {:else if systemInfo?.error}
      <div class="section"><p class="error">{systemInfo.error}</p></div>
    {:else if systemInfo}
      <div class="section">
        <h3>System</h3>
        <div class="config-grid">
          {#if systemInfo.host}
            <div class="cfg"><span class="cfg-label">Hostname</span><span class="cfg-value">{systemInfo.host.hostname ?? '—'}</span></div>
            <div class="cfg"><span class="cfg-label">OS</span><span class="cfg-value">{systemInfo.host.os ?? '—'}</span></div>
            <div class="cfg"><span class="cfg-label">Kernel</span><span class="cfg-value">{systemInfo.host.kernelVersion ?? '—'}</span></div>
            <div class="cfg"><span class="cfg-label">Arch</span><span class="cfg-value">{systemInfo.host.arch ?? '—'}</span></div>
            <div class="cfg"><span class="cfg-label">Uptime</span><span class="cfg-value">{formatUptime(systemInfo.host.uptime)}</span></div>
          {/if}
          {#if systemInfo.cpu}
            <div class="cfg"><span class="cfg-label">CPU</span><span class="cfg-value">{systemInfo.cpu.cores ?? '—'} cores{systemInfo.cpu.model ? `, ${systemInfo.cpu.model}` : ''}</span></div>
          {/if}
          {#if systemInfo.memory}
            <div class="cfg"><span class="cfg-label">Memory</span><span class="cfg-value">{formatBytes(systemInfo.memory.used)} / {formatBytes(systemInfo.memory.total)} ({systemInfo.memory.percent ?? '—'}%)</span></div>
          {/if}
        </div>
      </div>

      {#if systemInfo.containers}
        <div class="section">
          <h3>Containers</h3>
          <div class="stat-row compact">
            <div class="stat"><div class="stat-value">{systemInfo.containers.running ?? 0}</div><div class="stat-label">Running</div></div>
            <div class="stat"><div class="stat-value">{systemInfo.containers.stopped ?? 0}</div><div class="stat-label">Stopped</div></div>
            <div class="stat"><div class="stat-value">{systemInfo.containers.total ?? 0}</div><div class="stat-label">Total</div></div>
          </div>
        </div>
      {/if}

      {#if systemInfo.store}
        <div class="section">
          <h3>Storage</h3>
          <div class="config-grid">
            <div class="cfg"><span class="cfg-label">Images</span><span class="cfg-value">{systemInfo.store.imageCount ?? '—'}</span></div>
            <div class="cfg"><span class="cfg-label">Graph Driver</span><span class="cfg-value">{systemInfo.store.graphDriver ?? '—'}</span></div>
          </div>
        </div>
      {/if}

      {#if systemInfo.disk}
        <div class="section">
          <h3>Podman Disk Usage</h3>
          <div class="stat-row compact">
            <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.images)}</div><div class="stat-label">Images</div></div>
            <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.containers)}</div><div class="stat-label">Storage</div></div>
            <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.volumes)}</div><div class="stat-label">Volumes</div></div>
            <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.total)}</div><div class="stat-label">Podman Total</div></div>
          </div>
        </div>
        {#if systemInfo.disk.hostTotal}
          <div class="section">
            <h3>Host Disk</h3>
            <div class="stat-row compact">
              <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.hostUsed)}</div><div class="stat-label">Used</div></div>
              <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.hostAvailable)}</div><div class="stat-label">Available</div></div>
              <div class="stat"><div class="stat-value">{formatBytes(systemInfo.disk.hostTotal)}</div><div class="stat-label">Total</div></div>
              <div class="stat"><div class="stat-value">{systemInfo.disk.hostPercent ?? '—'}{#if systemInfo.disk.hostPercent != null}%{/if}</div><div class="stat-label">Used %</div></div>
            </div>
          </div>
        {/if}
      {/if}

      {#if systemInfo.network && (systemInfo.network.rxBytes != null || systemInfo.network.txBytes != null)}
        <div class="section">
          <h3>Network</h3>
          <div class="stat-row compact">
            <div class="stat"><div class="stat-value">{formatBytes(systemInfo.network.rxBytes)}</div><div class="stat-label">RX Total</div></div>
            <div class="stat"><div class="stat-value">{formatBytes(systemInfo.network.txBytes)}</div><div class="stat-label">TX Total</div></div>
          </div>
        </div>
      {/if}
    {/if}

  <!-- Metrics tab -->
  {:else if activeTab === 'metrics'}
    {@const m = (metricsClient && metricsClient.length > 0 ? metricsClient : data.metrics) || []}
    {#if metricsLoading}
      <div class="section"><p class="loading">Loading metrics…</p></div>
    {:else}
      <div class="section">
        <div class="section-header">
          <div class="metrics-toolbar">
            <h3>Metrics</h3>
            <div class="period-selector">
              {#each [{v:'1',l:'1h'},{v:'6',l:'6h'},{v:'12',l:'12h'},{v:'24',l:'24h'},{v:'72',l:'3d'},{v:'168',l:'7d'},{v:'720',l:'30d'}] as p}
                <button class="period-btn" class:active={metricsPeriod === p.v} onclick={() => { metricsPeriod = p.v; loadMetrics(); }}>{p.l}</button>
              {/each}
            </div>
            <button class="btn-tiny" onclick={loadMetrics} title="Refresh metrics">Refresh</button>
          </div>
        </div>
      {#if m.length === 0}
        <p class="empty">No metrics collected yet. Use "Collect Now" or wait for the background scheduler.</p>
      {:else}
        <div class="section">
          <h3>CPU Usage</h3>
          {@html chart(
            [{ values: m.map((pt: any) => pt.cpuPercent).reverse(), color: '#58a6ff', label: 'CPU' }],
            600, 120, '%'
          )}
        </div>
        <div class="section">
          <h3>Memory Usage</h3>
          {@html chart(
            [{ values: m.map((pt: any) => pt.memPercent).reverse(), color: '#3fb950', label: 'Memory' }],
            600, 120, '%'
          )}
        </div>
        <div class="section">
          <h3>Containers</h3>
          {@html chart(
            [
              { values: m.map((pt: any) => pt.containersRunning).reverse(), color: '#3fb950', label: 'Running' },
              { values: m.map((pt: any) => pt.containersTotal).reverse(), color: '#7a8494', label: 'Total' },
            ],
            600, 120, ''
          )}
        </div>
        <div class="section">
          <h3>Disk Usage</h3>
          {@html chart(
            [
              { values: m.map((pt: any) => pt.diskUsageBytes).reverse(), color: '#38bdf8', label: 'Podman Used' },
              { values: m.map((pt: any) => pt.diskLimitBytes).reverse(), color: '#7a8494', label: 'Host Total' },
            ],
            600, 120, ''
          )}
        </div>
        <div class="section">
          <h3>Network I/O</h3>
          {@html chart(
            [
              { values: m.map((pt: any) => pt.netRxBytes).reverse(), color: '#58a6ff', label: 'RX' },
              { values: m.map((pt: any) => pt.netTxBytes).reverse(), color: '#f0883e', label: 'TX' },
            ],
            600, 120, ''
          )}
        </div>
        <p class="section-hint">{m.length} samples</p>
      {/if}
      </div>
    {/if}

  <!-- Events tab -->
  {:else if activeTab === 'events'}
    <div class="section">
      <div class="events-toolbar">
        {#if eventSource === 'syslog' && terminalSshKey}
          <button class="btn-tiny" onclick={() => { terminalSshKey = ''; loadEvents(); }} title="Clear SSH key from memory">
            Clear Key
          </button>
        {/if}
        <select bind:value={eventSource} onchange={() => loadEvents()}>
          <option value="podman">Podman Events</option>
          <option value="syslog">System Logs</option>
        </select>
        {#if eventSource === 'podman'}
          <select bind:value={eventFilter} onchange={() => loadEvents()}>
            <option value="">All types</option>
            <option value="container">Container</option>
            <option value="image">Image</option>
            <option value="volume">Volume</option>
            <option value="pod">Pod</option>
            <option value="system">System</option>
          </select>
        {:else}
          <select bind:value={syslogSeverity} onchange={() => { eventPage = 0; applySyslogFilter(); }}>
            <option value="">All severities</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        {/if}
        <select bind:value={eventSince} onchange={() => loadEvents()}>
          <option value="1h">Last 1 hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
        <button class="btn-tiny" onclick={loadEvents} disabled={eventsLoading} title="Refresh events list">
          {eventsLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {#if eventsLoading}
        <p class="loading">Loading events…</p>
      {:else if events.length === 0}
        <div class="empty-state">
          <p class="empty">{syslogMessage || 'No events found'}</p>
          {#if eventSource === 'syslog' && !terminalSshKey}
            <button class="btn-tiny btn-accent" onclick={() => { showSyslogKeyPrompt = true; }}>
              Provide SSH Key
            </button>
          {/if}
        </div>
      {:else if eventSource === 'syslog'}
        <div class="events-list">
          {#each events as ev}
            <div class="event-row syslog-row">
              <span class="event-type syslog severity-{ev.priority}" title={ev.priority}>{ev.priority || '—'}</span>
              <span class="event-time">{ev.timestamp || ''}</span>
              <span class="event-name syslog-msg">{ev.message || ''}</span>
            </div>
          {/each}
        </div>
        {#if allSyslogEvents.length > EVENTS_PER_PAGE}
          <div class="paging-bar">
            <button class="btn-tiny" onclick={prevEventPage} disabled={eventPage === 0}>← Prev</button>
            <span class="paging-info">Page {eventPage + 1} of {Math.ceil(allSyslogEvents.filter(e => !syslogSeverity || e.priority === syslogSeverity).length / EVENTS_PER_PAGE)} · {allSyslogEvents.filter(e => !syslogSeverity || e.priority === syslogSeverity).length} events</span>
            <button class="btn-tiny" onclick={nextEventPage} disabled={(eventPage + 1) * EVENTS_PER_PAGE >= allSyslogEvents.filter(e => !syslogSeverity || e.priority === syslogSeverity).length}>Next →</button>
          </div>
        {/if}
      {:else}
        <div class="events-list">
          {#each events as ev}
            <div class="event-row">
              <span class="event-type {ev.Type || ev.type}">{ev.Type || ev.type || '—'}</span>
              <span class="event-action">{ev.Action || ev.action || '—'}</span>
              <span class="event-name">{ev.Actor?.Attributes?.name || ev.Actor?.Attributes?.image || ev.name || ''}</span>
              <span class="event-time">{ev.time ? timeAgo(new Date(ev.time * 1000).toISOString()) : (ev.timeNano ? timeAgo(new Date(ev.timeNano / 1e6).toISOString()) : '—')}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

  <!-- Containers tab -->
  {:else if activeTab === 'containers'}
    {#if data.containers.length === 0}
      <div class="section"><p class="empty">No containers on this worker</p></div>
    {:else}
      <div class="containers-list">
        {#each data.containers as c}
          <div class="container-card">
            <div class="container-top">
              <span class="container-name">{c.name}</span>
              <span class="status-badge {c.status}">{c.status}</span>
            </div>
            <div class="container-meta">
              <span>{c.image}</span>
              {#if c.applicationId}
                <a href="/applications/{c.applicationId}" class="app-link">View App</a>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

  <!-- Images tab -->
  {:else if activeTab === 'images'}
    {#if imagesLoading}
      <div class="section"><p class="loading">Loading images...</p></div>
    {:else}
      <div class="section">
        <div class="section-header">
          <div class="images-toolbar">
            <h3>Images</h3>
            <span class="section-hint">{images.length} images · {formatBytes(totalImageSize)} total</span>
          </div>
          <div class="images-actions">
            <button class="btn-tiny" onclick={() => { showPullForm = !showPullForm; imagePullError = ''; }}>
              {showPullForm ? 'Cancel' : 'Pull Image'}
            </button>
            <button class="btn-tiny" onclick={loadImages} title="Refresh images">Refresh</button>
          </div>
        </div>

        {#if showPullForm}
          <div class="inline-form">
            <input
              type="text"
              class="inline-input"
              placeholder="e.g. nginx:latest, postgres:16"
              bind:value={imagePullName}
              onkeydown={(e) => { if (e.key === 'Enter') pullImage(); }}
              disabled={imagePulling}
            />
            <button class="btn-tiny btn-accent" onclick={pullImage} disabled={imagePulling || !imagePullName.trim()}>
              {imagePulling ? 'Pulling...' : 'Pull'}
            </button>
            {#if imagePullError}
              <span class="inline-error">{imagePullError}</span>
            {/if}
          </div>
        {/if}

        {#if images.length === 0}
          <p class="empty">No images found on this worker</p>
        {:else}
          <table class="mini-table">
            <thead>
              <tr>
                <th>Repository / Tag</th>
                <th>ID</th>
                <th>Size</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each images as img}
                <tr>
                  <td>
                    {#if img.repoTags && img.repoTags.length > 0}
                      {#each img.repoTags as tag}
                        <span class="image-tag">{tag}</span>
                      {/each}
                    {:else}
                      <span class="text-muted">&lt;none&gt;</span>
                    {/if}
                  </td>
                  <td class="mono small">{img.id?.substring(0, 12) || '—'}</td>
                  <td>{formatBytes(img.size)}</td>
                  <td>{img.created ? (typeof img.created === 'number' ? new Date(img.created * 1000).toLocaleDateString() : new Date(img.created).toLocaleDateString()) : '—'}</td>
                  <td>
                    <button
                      class="btn-tiny btn-delete"
                      onclick={() => deleteImage(img.id)}
                      disabled={imageDeleting === img.id}
                      title="Delete this image"
                    >
                      {imageDeleting === img.id ? '...' : 'Delete'}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}

  <!-- Networks tab -->
  {:else if activeTab === 'networks'}
    {#if networksLoading}
      <div class="section"><p class="loading">Loading networks...</p></div>
    {:else}
      <div class="section">
        <div class="section-header">
          <div class="images-toolbar">
            <h3>Networks</h3>
            <span class="section-hint">{networks.length} networks</span>
          </div>
          <div class="images-actions">
            <button class="btn-tiny" onclick={() => { showNetworkForm = !showNetworkForm; networkCreateError = ''; }}>
              {showNetworkForm ? 'Cancel' : 'Create Network'}
            </button>
            <button class="btn-tiny" onclick={loadNetworks} title="Refresh networks">Refresh</button>
          </div>
        </div>

        {#if showNetworkForm}
          <div class="inline-form">
            <input
              type="text"
              class="inline-input"
              placeholder="Network name"
              bind:value={networkCreateName}
              onkeydown={(e) => { if (e.key === 'Enter') createNetwork(); }}
              disabled={networkCreating}
            />
            <select class="inline-select" bind:value={networkCreateDriver} disabled={networkCreating}>
              <option value="bridge">bridge</option>
              <option value="macvlan">macvlan</option>
            </select>
            <button class="btn-tiny btn-accent" onclick={createNetwork} disabled={networkCreating || !networkCreateName.trim()}>
              {networkCreating ? 'Creating...' : 'Create'}
            </button>
            {#if networkCreateError}
              <span class="inline-error">{networkCreateError}</span>
            {/if}
          </div>
        {/if}

        {#if networks.length === 0}
          <p class="empty">No networks found on this worker</p>
        {:else}
          <table class="mini-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Driver</th>
                <th>Subnet</th>
                <th>Gateway</th>
                <th>Containers</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each networks as net}
                <tr>
                  <td class="mono">{net.name}</td>
                  <td>{net.driver}</td>
                  <td class="mono small">{net.subnet}</td>
                  <td class="mono small">{net.gateway}</td>
                  <td>{net.containers}</td>
                  <td>{net.created ? new Date(net.created).toLocaleDateString() : '—'}</td>
                  <td>
                    {#if DEFAULT_NETWORKS.includes(net.name)}
                      <span class="text-muted small">default</span>
                    {:else}
                      <button
                        class="btn-tiny btn-delete"
                        onclick={() => deleteNetwork(net.name)}
                        disabled={networkDeleting === net.name}
                        title="Delete this network"
                      >
                        {networkDeleting === net.name ? '...' : 'Delete'}
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}

  <!-- Traefik tab -->
  {:else if activeTab === 'traefik'}
    {#if traefikLoading}
      <div class="section"><p class="loading">Loading Traefik data…</p></div>
    {:else if !traefik}
      <div class="section">
        <button class="btn-load" onclick={loadTraefik} title="Fetch Traefik configuration and logs">Load Traefik Data</button>
      </div>
    {:else if traefik.error}
      <div class="section"><p class="error">{traefik.error}</p></div>
    {:else}
      <!-- Traefik status -->
      <div class="section">
        <div class="section-header">
          <h3>Status</h3>
          <button class="btn-tiny" onclick={loadTraefik} title="Refresh Traefik data">Refresh</button>
        </div>
        <div class="config-grid">
          <div class="cfg"><span class="cfg-label">Container</span><span class="status-badge {traefik.status === 'running' ? 'online' : 'offline'}">{traefik.status}</span></div>
          {#if traefik.inspect?.Config?.Image}
            <div class="cfg"><span class="cfg-label">Image</span><span class="cfg-value mono">{traefik.inspect.Config.Image}</span></div>
          {/if}
          {#if traefik.inspect?.State?.StartedAt}
            <div class="cfg"><span class="cfg-label">Started</span><span class="cfg-value">{new Date(traefik.inspect.State.StartedAt).toLocaleString()}</span></div>
          {/if}
        </div>
      </div>

      <!-- Routing rules from our DB -->
      {#if traefik.routes && traefik.routes.length > 0}
        <div class="section">
          <h3>Routing Rules</h3>
          <table class="mini-table">
            <thead><tr><th>App</th><th>Rule</th><th>Entrypoint</th><th>Service</th></tr></thead>
            <tbody>
              {#each traefik.routes as route}
                <tr>
                  <td>{route.app}</td>
                  <td class="mono small">{route.rule}</td>
                  <td>{route.entrypoint}</td>
                  <td class="mono small">{route.service}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <!-- Static config -->
      {#if traefik.staticConfig}
        <div class="section">
          <h3>Static Configuration</h3>
          <pre class="config-block">{traefik.staticConfig}</pre>
        </div>
      {/if}

      <!-- Dynamic configs -->
      {#if traefik.dynamicConfigs && Object.keys(traefik.dynamicConfigs).length > 0}
        <div class="section">
          <h3>Dynamic Configuration</h3>
          {#each Object.entries(traefik.dynamicConfigs) as [filename, content]}
            <div class="dynamic-config">
              <span class="config-filename">{filename}</span>
              <pre class="config-block">{content}</pre>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Logs -->
      {#if traefik.logs}
        <div class="section">
          <div class="section-header">
            <h3>Logs</h3>
            <button class="btn-tiny" onclick={() => { traefik = null; loadTraefik(); }} title="Refresh logs">Refresh</button>
          </div>
          <pre class="logs-block">{traefik.logs}</pre>
        </div>
      {/if}
    {/if}

  <!-- CrowdSec tab -->
  {:else if activeTab === 'crowdsec'}
    {#if crowdsecLoading}
      <div class="section"><p class="loading">Loading CrowdSec data…</p></div>
    {:else if !crowdsec}
      <div class="section">
        <button class="btn-load" onclick={loadCrowdsec} title="Fetch CrowdSec status and logs">Load CrowdSec Data</button>
      </div>
    {:else if crowdsec.error}
      <div class="section"><p class="error">{crowdsec.error}</p></div>
    {:else}
      <!-- CrowdSec status -->
      <div class="section">
        <div class="section-header">
          <h3>Status</h3>
          <button class="btn-tiny" onclick={loadCrowdsec} title="Refresh CrowdSec data">Refresh</button>
        </div>
        <div class="config-grid">
          <div class="cfg"><span class="cfg-label">Container</span><span class="status-badge {crowdsec.status === 'running' ? 'online' : 'offline'}">{crowdsec.status}</span></div>
          {#if crowdsec.inspect?.Config?.Image}
            <div class="cfg"><span class="cfg-label">Image</span><span class="cfg-value mono">{crowdsec.inspect.Config.Image}</span></div>
          {/if}
          {#if crowdsec.inspect?.State?.StartedAt}
            <div class="cfg"><span class="cfg-label">Started</span><span class="cfg-value">{new Date(crowdsec.inspect.State.StartedAt).toLocaleString()}</span></div>
          {/if}
          {#if crowdsec.bouncerKey}
            <div class="cfg"><span class="cfg-label">Bouncer Key</span><span class="cfg-value mono">{crowdsec.bouncerKey}</span></div>
          {/if}
        </div>
      </div>

      <!-- Active Decisions -->
      {#if crowdsec.decisions && crowdsec.decisions.length > 0}
        <div class="section">
          <h3>Active Decisions ({crowdsec.decisions.length})</h3>
          <table class="mini-table">
            <thead><tr><th>Source</th><th>IP</th><th>Reason</th><th>Action</th><th>Duration</th></tr></thead>
            <tbody>
              {#each crowdsec.decisions as d}
                <tr>
                  <td>{d.source || '—'}</td>
                  <td class="mono small">{d.value || '—'}</td>
                  <td>{d.reason || '—'}</td>
                  <td>{d.type || '—'}</td>
                  <td>{d.duration || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="section">
          <h3>Active Decisions</h3>
          <p class="empty">No active decisions — all clear</p>
        </div>
      {/if}

      <!-- AppSec Rules -->
      {#if crowdsec.appsecStatus}
        <div class="section">
          <h3>AppSec Rules</h3>
          <pre class="config-block">{crowdsec.appsecStatus}</pre>
        </div>
      {/if}

      <!-- Logs -->
      {#if crowdsec.logs}
        <div class="section">
          <div class="section-header">
            <h3>Logs</h3>
            <button class="btn-tiny" onclick={() => { crowdsec = null; loadCrowdsec(); }} title="Refresh logs">Refresh</button>
          </div>
          <pre class="logs-block">{crowdsec.logs}</pre>
        </div>
      {/if}
    {/if}

  <!-- Terminal tab -->
  {:else if activeTab === 'terminal'}
    {#if showTerminalKeyPrompt}
      <SshKeyPrompt
        workerId={workerId}
        title={activeTab === 'terminal' ? "SSH Key for Terminal" : "SSH Key for System Logs"}
        description={activeTab === 'terminal' 
          ? "Paste the SSH private key to connect to this worker's terminal. The key is held in memory for this session only."
          : "Paste the SSH private key to fetch system logs. The key is held in memory for this session only."}
        submitLabel={activeTab === 'terminal' ? "Connect" : "Fetch Logs"}
        onsubmit={(key) => { 
          terminalSshKey = key; 
          showTerminalKeyPrompt = false; 
          if (activeTab === 'terminal') initTerminal();
          else if (activeTab === 'events') loadEvents();
        }}
        oncancel={() => { 
          showTerminalKeyPrompt = false; 
          if (activeTab === 'terminal') activeTab = 'overview';
        }}
      />
    {:else}
      <div class="terminal-section">
        {#if termConnecting}
          <div class="terminal-status">
            <div class="spinner"></div>
            <p>Connecting to {data.worker.name}…</p>
          </div>
        {:else if termError}
          <div class="terminal-status">
            <p class="error">{termError}</p>
            <button class="btn-load" onclick={() => { termError = ''; initTerminal(); }}>Retry</button>
          </div>
        {/if}
        <div bind:this={termEl} class="terminal-wrapper" style:display={termError || termConnecting ? 'none' : 'block'}></div>
      </div>
    {/if}

  <!-- Settings tab -->
  {:else if activeTab === 'settings'}
    <div class="section">
      <div class="section-header">
        <h3>Routing Configuration</h3>
        <span class="section-hint">Where this worker's Traefik gets its routes</span>
      </div>

      <div class="routing-modes">
        <div class="routing-mode" class:is-active={routingMode === 'labels'}>
          <h4>Container labels {#if routingMode === 'labels'}<span class="routing-badge">current</span>{/if}</h4>
          <p>
            Routes are stamped into each container as <code class="mono-inline">traefik.*</code> labels when it is
            created. Changing a rate limit, an auth mode or the worker's OIDC settings needs a redeploy, and worker
            OIDC needs the manual <strong>Apply to Traefik</strong> push below.
          </p>
        </div>
        <div class="routing-mode" class:is-active={routingMode === 'http'}>
          <h4>Control plane {#if routingMode === 'http'}<span class="routing-badge">current</span>{/if}</h4>
          <p>
            The worker fetches its routes from Rudder every 10 seconds and writes them to
            <code class="mono-inline">/etc/traefik/dynamic/routes.yml</code>. Rate limits, auth mode and worker OIDC
            take effect without touching a running container. The file on disk means a reboot during a Rudder
            outage still comes back serving.
          </p>
          {#if routingMode === 'http'}
            <p class="routing-status" class:is-stale={!configFetchedAt || Date.now() - new Date(configFetchedAt).getTime() > 60000}>
              {#if configFetchedAt}
                Last fetched {new Date(configFetchedAt).toLocaleString()}
              {:else}
                Never fetched — re-provision the worker to install the fetch timer.
              {/if}
            </p>
          {/if}
        </div>
      </div>

      <div class="form-actions">
        {#if routingMode === 'labels'}
          <button class="btn btn-primary" onclick={() => setRoutingMode('http')} disabled={routingSaving}>
            {routingSaving ? 'Switching…' : 'Switch to control-plane routing'}
          </button>
        {:else}
          <button class="btn btn-secondary" onclick={() => setRoutingMode('labels')} disabled={routingSaving}>
            {routingSaving ? 'Switching…' : 'Revert to container labels'}
          </button>
        {/if}
      </div>

      <p class="oidc-intro">
        Switching only records the intent. <strong>Re-provision the worker</strong> to install or remove the fetch
        timer, then <strong>redeploy its applications</strong> so their labels are dropped or restored. Both modes
        must never be live at once: two providers defining the same router name give Traefik one
        <code class="mono-inline">Host()</code> rule with arbitrary resolution between them.
      </p>

      {#if routingMsg}
        <p class="settings-msg" class:is-error={routingMsg.startsWith('Error')}>{routingMsg}</p>
      {/if}
    </div>

    <div class="section">
      <div class="section-header">
        <h3>Global OIDC Authentication</h3>
        <span class="section-hint">Protect all applications on this worker via an identity provider</span>
      </div>
      <p class="oidc-intro">
        When enabled, applications with <strong>Auth Type = “Default”</strong> will require users to sign in
        before they can access them. Every application on this worker shares one callback URL, so your
        identity provider needs only a single redirect URI registered.
      </p>

      {#if data.worker.baseDomain}
        <div class="oidc-prereq">
          <h4>Before enabling — two prerequisites</h4>
          <ol>
            <li>
              <strong>DNS A record.</strong> <code class="mono-inline">{oidcCallbackHost}</code> must resolve to
              this worker at <code class="mono-inline">{data.worker.hostname}</code>. The callback host is a real
              Traefik route: it terminates TLS with its own Let's Encrypt certificate, which can only be issued
              once the record exists. Without it every login attempt fails to resolve.
            </li>
            <li>
              <strong>Redirect URI.</strong> Register
              <code class="mono-inline">{oidcCallbackUrl}</code>
              with your identity provider — exactly this URL, for the client ID below.
            </li>
          </ol>
        </div>
      {:else}
        <div class="oidc-prereq is-warning">
          <h4>No base domain configured</h4>
          <p>
            This worker needs a base domain before OIDC can be enabled — the shared callback host is derived
            from it. Set one in the worker's configuration first.
          </p>
        </div>
      {/if}

      {#if oidcEnabled && oidcClientSecretSet && routingMode === 'http'}
        <div class="oidc-prereq">
          <h4>Delivered with the routes</h4>
          <p>
            This worker fetches its routing configuration from Rudder, and the OIDC middleware travels with it.
            Saving here takes effect within one poll — no push, no redeploy, and no window where a router
            references a middleware the worker does not have.
          </p>
        </div>
      {:else if oidcEnabled && oidcClientSecretSet && !oidcAppliedAt}
        <div class="oidc-prereq is-warning">
          <h4>Not yet pushed to Traefik</h4>
          <p>
            This configuration is saved but has not reached the worker. Deployments are blocked until you click
            <strong>Apply to Traefik</strong> — deploying now would either take applications offline or publish
            them without authentication.
          </p>
        </div>
      {/if}

      <div class="settings-form">
        <div class="form-field">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={oidcEnabled} />
            <span>Enable Global OIDC</span>
          </label>
        </div>

        {#if oidcEnabled || oidcProviderUrl}
          <div class="oidc-fields">
            <div class="form-field">
              <label for="oidcProviderUrl">Provider URL <span class="req">*</span></label>
              <input type="url" id="oidcProviderUrl"
                placeholder="https://accounts.google.com"
                bind:value={oidcProviderUrl} />
              <p class="field-hint">OIDC discovery endpoint (Google, Azure AD, Okta, Keycloak, etc.)</p>
            </div>

            <div class="form-row-2">
              <div class="form-field">
                <label for="oidcClientId">Client ID <span class="req">*</span></label>
                <input type="text" id="oidcClientId"
                  placeholder="your-client-id"
                  bind:value={oidcClientId} />
              </div>
              <div class="form-field">
                <label for="oidcClientSecret">Client Secret</label>
                <input type="password" id="oidcClientSecret"
                  placeholder={oidcClientSecretSet ? '••••• (saved — paste to replace)' : 'your-client-secret'}
                  bind:value={oidcClientSecret} />
                {#if oidcClientSecretSet && !oidcClientSecret}
                  <p class="field-hint">A secret is saved. Leave blank to keep it.</p>
                {/if}
              </div>
            </div>

            <div class="form-field">
              <label for="oidcEncKey">Session Encryption Key</label>
              <input type="password" id="oidcEncKey" disabled
                placeholder={oidcEncryptionKeySet ? '••••• (auto-managed)' : 'Will be auto-generated on save'} />
              <p class="field-hint">
                Auto-generated 32-character key for encrypting session cookies. Managed automatically.
                Rotating it signs every user out.
              </p>
            </div>
          </div>
        {/if}

        <div class="form-actions">
          <button class="btn btn-primary" onclick={saveOidcSettings} disabled={oidcSaving}>
            {oidcSaving ? 'Saving…' : 'Save Settings'}
          </button>
          {#if oidcEnabled && oidcClientSecretSet && routingMode !== 'http'}
            <button class="btn btn-secondary" onclick={() => showOidcApplyPrompt = true} disabled={oidcApplying}
              title="Push OIDC config to Traefik on this worker via SSH (takes effect immediately, no redeploy needed)">
              {oidcApplying ? 'Applying…' : 'Apply to Traefik'}
            </button>
          {/if}
          {#if oidcClientSecretSet || oidcProviderUrl}
            <button class="btn btn-outline-danger" onclick={clearOidcSettings}>Clear OIDC</button>
          {/if}
        </div>

        {#if oidcSaveMsg}
          <p class="settings-msg" class:is-error={oidcSaveMsg.startsWith('Error')}>{oidcSaveMsg}</p>
        {/if}
        {#if oidcApplyMsg}
          <p class="settings-msg" class:is-error={oidcApplyMsg.startsWith('Error')}>{oidcApplyMsg}</p>
        {/if}
      </div>
    </div>

    <div class="section">
      <h3>How It Works</h3>
      <div class="help-grid">
        <div class="help-item">
          <div class="help-icon">🛡️</div>
          <div>
            <strong>Auth Type = Default</strong>
            <p>Protected by this worker’s global OIDC config. Users must sign in.</p>
          </div>
        </div>
        <div class="help-item">
          <div class="help-icon">🔓</div>
          <div>
            <strong>Auth Type = None</strong>
            <p>Always public. OIDC is bypassed for this application.</p>
          </div>
        </div>
        <div class="help-item">
          <div class="help-icon">🔑</div>
          <div>
            <strong>Auth Type = Custom OIDC</strong>
            <p>Uses per-app credentials and its own callback on the app's own host. Independent of this worker setting.</p>
          </div>
        </div>
        <div class="help-item">
          <div class="help-icon">🍪</div>
          <div>
            <strong>One session, all apps</strong>
            <p>
              The session cookie is shared across every subdomain of this worker, so signing in to one
              “Default” app signs the user in to all of them. Use <em>Custom OIDC</em> with allowed users,
              or a separate worker, where apps must not share an audience.
            </p>
          </div>
        </div>
      </div>
    </div>

    {#if showOidcApplyPrompt}
      <SshKeyPrompt
        workerId={workerId}
        title="Apply OIDC Config to Traefik"
        description="Provide your SSH private key to push the updated OIDC middleware configuration to this worker. Traefik hot-reloads the change within seconds — no restart or redeploy needed."
        submitLabel="Apply"
        onsubmit={(key) => applyOidcToTraefik(key)}
        oncancel={() => showOidcApplyPrompt = false}
      />
    {/if}
  {/if}
</div>

<style>
  /* Modal styles moved to SshKeyPrompt component */
  .page {
    padding: 0 24px;
  }

  /* ── Header ────────────────────────────────────── */

  .header { margin-bottom: 24px; }

  .header-top {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
  }

  .back-link {
    font-size: 13px; color: var(--text-muted); text-decoration: none;
    transition: color 0.15s;
  }
  .back-link:hover { color: var(--text-primary); }

  .header-actions { display: flex; gap: 6px; }

  .btn-tiny {
    padding: 5px 12px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border-default);
    background: var(--bg-raised); color: var(--text-secondary);
    text-decoration: none; transition: all 0.15s;
  }
  .btn-tiny:hover:not(:disabled) {
    background: var(--bg-hover); color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .btn-tiny:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn-prune {
    color: var(--red-text); border-color: color-mix(in srgb, var(--red) 30%, transparent);
    background: var(--red-subtle);
  }
  .btn-prune:hover:not(:disabled) {
    background: color-mix(in srgb, var(--red) 20%, transparent);
    border-color: var(--red);
  }
  .btn-delete {
    color: var(--red-text); border-color: color-mix(in srgb, var(--red) 30%, transparent);
  }
  .btn-delete:hover {
    background: var(--red-subtle);
    border-color: var(--red);
  }

  .title-row { display: flex; align-items: center; gap: 12px; }
  .title-row h1 {
    font-size: 24px; font-weight: 700; color: var(--text-primary); margin: 0;
    letter-spacing: -0.01em;
  }

  .status-badge {
    padding: 3px 10px; border-radius: 10px; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .status-badge.online { background: var(--green-subtle); color: var(--green-text); }
  .status-badge.offline { background: var(--red-subtle); color: var(--red-text); }
  .status-badge.provisioning { background: var(--yellow-subtle); color: var(--yellow-text); }
  .status-badge.error { background: var(--red-subtle); color: var(--red-text); }

  .meta-row { display: flex; gap: 14px; margin-top: 6px; }
  .meta { font-size: 12.5px; color: var(--text-muted); }
  .meta.mono { font-family: var(--font-mono); font-size: 12px; }

  /* ── Stats ─────────────────────────────────────── */

  .stat-row {
    display: flex; gap: 12px; margin-bottom: 20px;
  }
  .stat-row.compact { gap: 12px; margin-bottom: 0; }

  .stat {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 14px 18px; min-width: 100px; flex: 1;
    transition: border-color 0.15s;
  }
  .stat:hover { border-color: var(--border-default); }

  .stat-value {
    font-size: 22px; font-weight: 700; color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
  .stat-label {
    font-size: 10px; color: var(--text-muted); margin-top: 4px;
    text-transform: uppercase; letter-spacing: 0.06em;
  }

  /* ── Section ───────────────────────────────────── */

  .section {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 18px 20px; margin-bottom: 12px;
  }

  .section-header {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;
  }

  .section h3 {
    font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.06em; margin: 0 0 12px;
  }

  .section-header h3 { margin: 0; }

  .section-hint { font-size: 11px; color: var(--text-muted); }

  /* Availability */
  :global(.avail-bar) { display: block; border-radius: var(--radius-sm); overflow: hidden; }
  .avail-legend { display: flex; gap: 14px; margin-top: 6px; }
  .avail-legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); }
  .avail-dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 2px;
  }
  .avail-dot.online { background: #3fb950; }
  .avail-dot.mixed { background: #d29922; }
  .avail-dot.offline { background: #f85149; }
  .avail-dot.nodata { background: var(--bg-overlay); }

  .loading {
    color: var(--text-muted); font-size: 13px; font-style: italic;
  }
  .error { color: var(--red-text); font-size: 13px; }
  .empty {
    color: var(--text-muted); font-size: 13px; font-style: italic;
    text-align: center; padding: 24px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 0;
  }
  .empty-state .empty { padding: 0 0 16px 0; }

  .patch-warn { color: var(--yellow-text, var(--accent)); font-weight: 600; }
  .patch-unknown { color: var(--text-muted); font-style: italic; }

  /* ── Provisioning dialog extras ────────────────── */

  .provision-option {
    display: flex; align-items: flex-start; gap: 8px; margin: 4px 0 0;
    font-size: 12px; color: var(--text-secondary); cursor: pointer;
  }
  .provision-option input { accent-color: var(--accent); margin-top: 2px; }
  .provision-option em {
    display: block; font-style: normal; color: var(--text-muted);
    font-size: 11px; line-height: 1.5; margin-top: 2px;
  }

  /* ── Config grid ───────────────────────────────── */

  .config-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px;
  }

  .cfg { display: flex; flex-direction: column; gap: 3px; }
  .cfg-label {
    font-size: 10px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.05em; font-weight: 500;
  }
  .cfg-value {
    font-size: 14px; color: var(--text-primary); word-break: break-all;
  }
  .cfg-value.mono { font-family: var(--font-mono); font-size: 13px; color: var(--text-secondary); }

  /* ── Metrics strip ─────────────────────────────── */

  .metrics-strip {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px;
  }

  .metric-card {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 14px 16px;
    transition: border-color 0.15s;
  }
  .metric-card:hover { border-color: var(--border-default); }

  .metric-label {
    font-size: 10px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.06em; margin-bottom: 6px; font-weight: 500;
  }
  .metric-value {
    font-size: 18px; font-weight: 700; color: var(--text-primary); margin-top: 4px;
    font-variant-numeric: tabular-nums;
  }

  /* ── Tabs ──────────────────────────────────────── */

  .tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border-subtle); margin-bottom: 16px;
  }

  .tabs button {
    padding: 10px 16px; background: none; border: none;
    border-bottom: 2px solid transparent; cursor: pointer;
    font-size: 13px; color: var(--text-muted); font-weight: 500;
    margin-bottom: -1px; transition: all 0.15s;
  }
  .tabs button:hover { color: var(--text-primary); }
  .tabs button.active {
    color: var(--accent); border-bottom-color: var(--accent);
  }

  /* ── Charts ────────────────────────────────────── */

  :global(.chart-container) { position: relative; }
  :global(.chart-legend) {
    display: flex; gap: 14px; font-size: 12px; color: var(--text-secondary); margin-top: 8px;
  }
  :global(.chart-empty) {
    color: var(--text-muted); font-size: 13px; font-style: italic;
    text-align: center; padding: 24px;
  }

  /* ── Events ────────────────────────────────────── */

  .events-toolbar {
    display: flex; gap: 8px; margin-bottom: 14px; align-items: center;
  }

  .events-toolbar select {
    padding: 6px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    font-size: 12px; background: var(--bg-input); color: var(--text-primary);
    cursor: pointer;
  }
  .events-toolbar select:focus {
    outline: none; border-color: var(--border-focus);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .events-list { display: flex; flex-direction: column; }

  .event-row {
    display: flex; align-items: center; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid var(--border-subtle); font-size: 13px;
  }
  .event-row:last-child { border-bottom: none; }

  .event-type {
    padding: 2px 8px; border-radius: var(--radius-sm); font-size: 10px; font-weight: 600;
    text-transform: uppercase; background: var(--bg-overlay); color: var(--text-muted);
    min-width: 60px; text-align: center;
  }
  .event-type.container { background: var(--blue-subtle); color: var(--blue-text); }
  .event-type.image { background: var(--purple-subtle); color: var(--purple); }
  .event-type.volume { background: var(--green-subtle); color: var(--green-text); }
  .event-type.pod { background: var(--accent-subtle); color: var(--accent-text); }
  .event-type.syslog { background: var(--yellow-subtle); color: var(--yellow-text); }
  .event-type.severity-error { background: var(--red-subtle); color: var(--red-text); }
  .event-type.severity-warning { background: var(--yellow-subtle); color: var(--yellow-text); }
  .event-type.severity-info { background: var(--blue-subtle); color: var(--blue-text); }

  .event-action { color: var(--text-secondary); font-weight: 500; }
  .event-name {
    color: var(--text-muted); font-family: var(--font-mono); font-size: 12px;
    flex: 1; overflow: hidden; text-overflow: ellipsis;
  }
  .event-time { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

  /* ── Containers ────────────────────────────────── */

  .containers-list {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
  }

  .container-card {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 14px 16px;
    transition: border-color 0.15s;
  }
  .container-card:hover { border-color: var(--border-default); }

  .container-top {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
  }
  .container-name { font-weight: 600; font-size: 14px; color: var(--text-primary); }

  .container-meta { display: flex; gap: 10px; font-size: 12px; color: var(--text-muted); }
  .app-link {
    color: var(--accent); text-decoration: none; font-size: 12px;
    transition: color 0.15s;
  }
  .app-link:hover { color: var(--accent-hover); }

  /* ── Traefik ──────────────────────────────────── */

  .btn-load {
    padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border-default);
    background: var(--bg-hover); color: var(--text-secondary);
    transition: all 0.15s;
  }
  .btn-load:hover {
    background: var(--bg-active); color: var(--text-primary);
    border-color: var(--border-strong);
  }

  .config-block {
    background: var(--bg-overlay); color: var(--text-secondary);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 14px 18px; font-family: var(--font-mono); font-size: 12px;
    overflow-x: auto; white-space: pre-wrap; line-height: 1.6;
    max-height: 400px; overflow-y: auto; margin: 0;
  }

  .logs-block {
    background: var(--bg-root); color: var(--text-muted);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 14px 18px; font-family: var(--font-mono); font-size: 11px;
    overflow-x: auto; white-space: pre-wrap; line-height: 1.6;
    max-height: 800px; overflow-y: auto; margin: 0;
  }

  .dynamic-config { margin-bottom: 12px; }
  .dynamic-config:last-child { margin-bottom: 0; }

  .config-filename {
    display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent);
    margin-bottom: 6px; font-family: var(--font-mono);
  }

  .mini-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .mini-table th {
    text-align: left; padding: 8px 10px; font-size: 10px; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
    background: var(--bg-overlay); border-bottom: 1px solid var(--border-default);
  }
  .mini-table td {
    padding: 8px 10px; border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }
  .mini-table tr:hover td { background: var(--bg-hover); }
  .mono { font-family: var(--font-mono); }
  .small { font-size: 11px; }

  /* ── Syslog ────────────────────────────────────── */

  .syslog-row { font-family: var(--font-mono); font-size: 12px; }
  .syslog-msg {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--font-mono); font-size: 12px;
  }

  /* ── Terminal ──────────────────────────────────── */

  .terminal-section {
    background: #1e1e1e; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); overflow: hidden; min-height: 400px;
    position: relative; width: 100%;
  }

  .terminal-wrapper {
    width: 100%; height: 800px;
  }

  .terminal-status {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 400px; color: #d4d4d4;
  }

  .spinner {
    width: 36px; height: 36px; border: 3px solid #333;
    border-top: 3px solid #007acc; border-radius: 50%;
    animation: spin 1s linear infinite; margin-bottom: 12px;
  }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

  :global(.terminal-section .xterm) { height: 100% !important; width: 100% !important; }
  :global(.terminal-section .xterm-viewport) { scrollbar-color: #666 #1e1e1e; }
  :global(.terminal-section .xterm-screen) { width: 100% !important; }
  :global(.terminal-section .xterm canvas) { width: 100% !important; }

  /* ── Metrics toolbar ──────────────────────────── */

  .metrics-toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .metrics-toolbar h3 { margin: 0; }

  .period-selector {
    display: flex; gap: 2px; background: var(--bg-overlay); border-radius: var(--radius-sm); padding: 2px;
  }
  .period-btn {
    padding: 3px 8px; border: none; border-radius: 3px; font-size: 11px; font-weight: 500;
    background: transparent; color: var(--text-muted); cursor: pointer; transition: all 0.15s;
  }
  .period-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
  .period-btn.active { background: var(--accent); color: #fff; }

  /* ── Paging bar ───────────────────────────────── */

  .paging-bar {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    padding: 12px 0 4px; font-size: 12px; color: var(--text-muted);
  }
  .paging-info { font-variant-numeric: tabular-nums; }

  /* ── Images & Networks ────────────────────────── */

  .images-toolbar {
    display: flex; align-items: center; gap: 8px;
  }
  .images-toolbar h3 { margin: 0; }

  .images-actions {
    display: flex; gap: 6px;
  }

  .inline-form {
    display: flex; align-items: center; gap: 8px; padding: 12px 0;
    border-bottom: 1px solid var(--border-subtle); margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .inline-input {
    padding: 7px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    font-size: 13px; background: var(--bg-input); color: var(--text-primary);
    min-width: 260px; font-family: var(--font-mono);
  }
  .inline-input:focus {
    outline: none; border-color: var(--border-focus);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }
  .inline-input:disabled { opacity: 0.5; }

  .inline-select {
    padding: 7px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    font-size: 12px; background: var(--bg-input); color: var(--text-primary); cursor: pointer;
  }
  .inline-select:focus {
    outline: none; border-color: var(--border-focus);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .inline-error {
    font-size: 12px; color: var(--red-text); flex-basis: 100%;
  }

  .btn-accent {
    background: var(--accent); color: #fff; border-color: var(--accent);
  }
  .btn-accent:hover:not(:disabled) {
    background: var(--accent-hover, var(--accent)); border-color: var(--accent);
    color: #fff;
  }
  .btn-accent:disabled { opacity: 0.5; cursor: not-allowed; }

  .image-tag {
    display: inline-block; padding: 1px 6px; background: var(--bg-overlay);
    border-radius: 3px; font-size: 12px; font-family: var(--font-mono);
    color: var(--text-primary); margin: 1px 4px 1px 0;
  }

  .text-muted { color: var(--text-muted); }

  /* ── Settings tab ────────────────────────────── */
  .settings-form { display: flex; flex-direction: column; gap: 16px; }
  .form-field { display: flex; flex-direction: column; gap: 4px; }
  .form-field label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .form-field input[type='text'],
  .form-field input[type='url'],
  .form-field input[type='password'] {
    padding: 8px 10px; background: var(--bg-overlay, rgba(0,0,0,0.2));
    border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.9rem; width: 100%;
  }
  .form-field input:disabled { opacity: 0.55; cursor: not-allowed; }
  .form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .toggle-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.92rem; font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--text); }
  .toggle-label input[type='checkbox'] { width: 16px; height: 16px; cursor: pointer; }
  .oidc-fields { display: flex; flex-direction: column; gap: 14px; padding: 16px; background: var(--bg-overlay, rgba(0,0,0,0.1)); border-radius: 8px; border: 1px solid var(--border); }
  .field-hint { font-size: 11px; color: var(--text-muted); margin: 2px 0 0; }
  .oidc-intro { font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 4px; }
  .oidc-prereq {
    margin: 12px 0 16px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent, #4a9eff);
    border-radius: 8px;
    background: var(--bg-overlay, rgba(0, 0, 0, 0.1));
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-secondary);
  }
  .oidc-prereq h4 { margin: 0 0 8px; font-size: 13px; color: var(--text-primary); }
  .oidc-prereq ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
  .oidc-prereq p { margin: 0; }
  .oidc-prereq.is-warning { border-left-color: var(--warning, #e0a030); }
  .routing-modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin: 12px 0 16px; }
  .routing-mode {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-overlay, rgba(0, 0, 0, 0.1));
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-secondary);
    opacity: 0.65;
  }
  .routing-mode.is-active { opacity: 1; border-color: var(--accent, #4a9eff); }
  .routing-mode h4 { margin: 0 0 8px; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
  .routing-mode p { margin: 0 0 6px; }
  .routing-badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 7px; border-radius: 10px; background: var(--accent, #4a9eff); color: #fff; font-weight: 600; }
  .routing-status { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
  .routing-status.is-stale { color: var(--warning, #e0a030); }
  .mono-inline { font-family: var(--font-mono); font-size: 12px; background: var(--bg-overlay, rgba(0,0,0,0.2)); padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; word-break: break-all; }
  .req { color: var(--red, #f87171); }
  .form-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding-top: 4px; }
  .btn { padding: 7px 16px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; font-size: 0.88rem; font-weight: 500; transition: all 0.15s; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-primary:hover:not(:disabled) { opacity: 0.88; }
  .btn-secondary { background: var(--bg-raised); color: var(--text); border-color: var(--border); }
  .btn-secondary:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .btn-outline-danger { background: transparent; color: var(--red-text, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
  .btn-outline-danger:hover { background: var(--red-subtle, rgba(248,113,113,0.1)); border-color: var(--red, #f87171); }
  .settings-msg { margin-top: 4px; padding: 8px 12px; border-radius: 6px; font-size: 0.87rem; background: rgba(50,200,100,0.08); color: var(--text); border: 1px solid rgba(50,200,100,0.2); }
  .settings-msg.is-error { background: rgba(200,50,50,0.08); color: var(--red-text, #f87171); border-color: rgba(200,50,50,0.2); }
  .help-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: 4px; }
  .help-item { display: flex; gap: 12px; align-items: flex-start; }
  .help-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
  .help-item strong { display: block; font-size: 13px; margin-bottom: 2px; }
  .help-item p { font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.4; }

</style>
