<script lang="ts">
  import { formatBytes, formatUptime, timeAgo } from '$lib/format';
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import SshKeyPrompt from '$lib/components/SshKeyPrompt.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { showToast } from '$lib/client/toast.svelte';
  import { confirmAction } from '$lib/client/dialog.svelte';
  import AppsecMatches from '$lib/components/AppsecMatches.svelte';

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
  /**
   * A provisioning run that succeeded but left the worker unable to fetch its
   * routing. Separate from `provisionMsg`, which renders as button text and has
   * room for one word — which is why this used to go unsaid entirely.
   */
  let provisionWarning = $state('');
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
  let removingDecision = $state<number | null>(null);
  let decisionError = $state('');
  /** `host|rule` while that chip's request is in flight. */
  let excludingRule = $state<string | null>(null);
  let ruleMessage = $state('');
  let ruleError = $state(false);

  let terminalReady = $state(false);

  // ── OIDC Settings state ──────────────────────────────────────────
  let oidcEnabled = $state(false);
  let oidcProviderUrl = $state('');
  let oidcClientId = $state('');
  let oidcClientSecret = $state('');
  let oidcClientSecretSet = $state(false);
  let oidcEncryptionKeySet = $state(false);
  let oidcAppliedAt = $state<string | null>(null);
  // Path of the shared callback. Providers compare redirect URIs by exact
  // string, so a client registered as /oauth2/callback needs that path here.
  let oidcCallbackPath = $state('/oidc/callback');
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
  // The worker's last fetch *attempt*, reported over the metrics endpoint.
  // Without it a failing worker and a never-provisioned one look the same, and
  // the remedy for each is the opposite of the other's.
  const fetchStatus = $derived(routingFetchCleared ? null : (data.worker.configFetchStatus ?? null));
  const fetchDetail = $derived(routingFetchCleared ? null : (data.worker.configFetchDetail ?? null));
  const fetchAttemptAt = $derived(
    routingFetchCleared ? null : (data.worker.configFetchAttemptAt ?? null),
  );
  const fetchFailing = $derived(fetchStatus != null && fetchDetail !== 'ok' && fetchDetail !== 'no-routes');

  /** What a failed fetch means, in the terms the operator has to act on. */
  const fetchFailureHint = $derived.by(() => {
    if (!fetchFailing) return '';
    if (fetchDetail === 'transport' || fetchStatus === 0) {
      return 'The worker cannot reach the control plane at all — check DNS, egress and TLS trust from the worker.';
    }
    // Before the plain 401: same status, and the request never reached Rudder.
    if (fetchDetail === 'proxy-auth') {
      return basicUser
        ? 'A proxy in front of the control plane rejected the Basic credentials configured below. Check them, then re-provision — the worker only picks up a change at provisioning time.'
        : 'Something in front of the control plane is demanding its own credentials, so the request never reaches Rudder. Either exempt this endpoint at that proxy, or set its Basic credentials below and re-provision.';
    }
    if (fetchStatus === 401) {
      return 'The worker’s token does not match the stored one. Re-provision to reissue it, and do not switch routing mode afterwards.';
    }
    if (fetchStatus === 409) {
      return 'The control plane has this worker in labels mode. Switch it to control-plane routing, then provision.';
    }
    if (fetchStatus === 503) {
      return 'The control plane could not build this worker’s configuration. Check its logs for a generation failure.';
    }
    if (fetchDetail === 'not-a-document') {
      return 'The endpoint answered with something that is not a routing document — usually a login redirect or a proxy error page in front of the control plane.';
    }
    if (fetchDetail === 'no-token') {
      return 'The worker has no config token. Re-provision to issue one.';
    }
    return 'Applications stay on their existing routes until the fetch succeeds.';
  });
  let routingSaving = $state(false);
  let routingMsg = $state('');

  // ── Control-plane Basic auth ──────────────────────────────────────
  // For deployments that publish Rudder behind a proxy of their own. Loaded
  // with the rest of the Settings tab rather than seeded from the page payload:
  // the password never leaves the server, only a flag saying one is stored.
  let basicUser = $state('');
  let basicPassword = $state('');
  let basicPasswordSet = $state(false);
  let basicSaving = $state(false);
  let basicMsg = $state('');

  // ── Adoption ──────────────────────────────────────────────────────────────
  //
  // Containers on this worker that Rudder does not manage. Nothing is imported
  // automatically any more: adoption changes what Rudder claims to own, so it
  // happens when someone here says so.
  interface Adoptable {
    containerId: string;
    name: string;
    image: string;
    status: string;
    domain: string | null;
    suggestedName: string;
    suggestedTeamId: string | null;
  }
  let adoptable = $state<Adoptable[]>([]);
  let adoptLoading = $state(false);
  let adoptLoaded = $state(false);
  let adopting = $state(false);
  let adoptMsg = $state('');
  /** Per-container operator edits, keyed by container id. */
  let adoptPick = $state<Record<string, { selected: boolean; name: string; teamId: string }>>({});

  async function loadAdoptable() {
    adoptLoading = true;
    adoptMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/adopt`);
      const body = await res.json();
      if (res.ok) {
        adoptable = body.containers ?? [];
        const picks: typeof adoptPick = {};
        for (const c of adoptable) {
          picks[c.containerId] = {
            selected: false,
            name: c.suggestedName,
            teamId: c.suggestedTeamId ?? '',
          };
        }
        adoptPick = picks;
        adoptLoaded = true;
      } else {
        adoptMsg = body.error || 'Could not list containers';
      }
    } catch (e: any) {
      adoptMsg = e.message;
    } finally {
      adoptLoading = false;
    }
  }

  async function adoptSelected() {
    const chosen = adoptable.filter((c) => adoptPick[c.containerId]?.selected);
    if (chosen.length === 0) {
      adoptMsg = 'Select at least one container';
      return;
    }
    adopting = true;
    adoptMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          containers: chosen.map((c) => ({
            containerId: c.containerId,
            name: adoptPick[c.containerId].name,
            teamId: adoptPick[c.containerId].teamId || null,
            domain: c.domain,
          })),
        }),
      });
      const body = await res.json();
      if (res.ok) {
        adoptMsg = body.message;
        if (body.skipped?.length) {
          adoptMsg += ` — ${body.skipped.map((s: any) => s.reason).join('; ')}`;
        }
        if (body.adopted?.length) setTimeout(() => invalidateAll(), 1200);
      } else {
        adoptMsg = body.error || 'Adoption failed';
      }
    } catch (e: any) {
      adoptMsg = e.message;
    } finally {
      adopting = false;
    }
  }

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

  /**
   * Lift one CrowdSec decision.
   *
   * Confirmed first, and the prompt names the address: this removes a security
   * control on a production worker, and the row it was clicked from is one of
   * several that look alike.
   */
  async function removeDecision(d: { id: number; value: string; scope: string; reason: string }) {
    const who = d.scope ? `${d.scope}:${d.value}` : d.value;
    if (!confirm(`Lift the ${d.reason || 'CrowdSec'} decision on ${who}?\n\nIt will be re-applied if the same behaviour repeats.`)) {
      return;
    }
    decisionError = '';
    removingDecision = d.id;
    try {
      const res = await fetch(`/api/workers/${workerId}/crowdsec?decision=${d.id}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        decisionError = body.error || body.message || `Could not remove decision ${d.id}.`;
      }
    } catch (e: any) {
      decisionError = e.message;
    } finally {
      removingDecision = null;
      // Re-read rather than splice the row out: the list is the worker's answer,
      // not ours, and a delete that half-worked should show as still there.
      await loadCrowdsec();
    }
  }

  /**
   * Stop one rule firing for the application on `host`.
   *
   * Offered here because this is where the evidence is. Making someone find the
   * application, open its edit form and retype a six-digit number is where the
   * mistakes come from — and the number they would most likely retype is the
   * wrong one, since the rule a decision names is the first in the chain rather
   * than the one that scored.
   */
  async function excludeRule(host: string, rule: string, source?: string) {
    if (!host) return;

    // Anomaly-gate and setup rules are not rendered as buttons at all, so this
    // is unreachable from the UI — the endpoint refuses them regardless.
    const scope = source
      ? `only for requests from ${source}. The rule keeps protecting that application ` +
        `against every other address.`
      : `for all traffic. It stops protecting that application against everyone, on every ` +
        `port it serves.`;
    if (!confirm(`Stop rule ${rule} firing for ${host}?\n\nDisabled ${scope}\n\n` +
      `CrowdSec restarts on this worker within a minute.`)) return;

    ruleMessage = '';
    ruleError = false;
    excludingRule = `${host}|${rule}${source ? `@${source}` : ''}`;
    try {
      const res = await fetch('/api/applications/appsec-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, rule, source }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        ruleError = true;
        ruleMessage = body.error || `Could not exclude rule ${rule}.`;
      } else if (body.added === false) {
        ruleMessage = `${body.application} already excluded rule ${rule}.`;
      } else {
        ruleMessage =
          `Rule ${rule} excluded for ${body.application}. ` +
          `The worker applies it within a minute.`;
      }
    } catch (e: any) {
      ruleError = true;
      ruleMessage = e.message;
    } finally {
      excludingRule = null;
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
    const ok = await confirmAction({
      title: 'Delete this image?',
      body: 'It will be removed from this worker. Podman refuses if a container is still using it.',
      confirmLabel: 'Delete image',
      danger: true,
    });
    if (!ok) return;
    imageDeleting = imageId;
    try {
      const res = await fetch(`/api/workers/${workerId}/images?image=${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
      });
      const body = await res.json();
      // A 409 here is Podman saying the image is still in use — a sentence the
      // operator can act on, which is why it goes to a toast and not an alert().
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      showToast('success', 'Image deleted');
      await loadImages();
    } catch (e: any) {
      showToast('error', e.message);
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
    const ok = await confirmAction({
      title: `Delete network "${networkName}"?`,
      body: 'This cannot be undone. Containers attached to it will lose that network.',
      confirmLabel: 'Delete network',
      danger: true,
    });
    if (!ok) return;
    networkDeleting = networkName;
    try {
      const res = await fetch(`/api/workers/${workerId}/networks?name=${encodeURIComponent(networkName)}`, {
        method: 'DELETE',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      showToast('success', 'Network deleted');
      await loadNetworks();
    } catch (e: any) {
      showToast('error', e.message);
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
    if (tab === 'settings' && !oidcLoaded) { loadOidcSettings(); loadConfigAuth(); }
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
        setTimeout(() => invalidateAll(), 1500);
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
    provisionWarning = '';
    try {
      const res = await fetch('/api/workers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId, sshPrivateKey: sshKey, applyUpdates }),
      });
      const body = await res.json();
      if (body.success) {
        // Provisioning can succeed while the worker still cannot fetch a single
        // route. Saying only "Provisioned!" invites the next step — redeploying
        // the applications — which drops the labels that are still routing them.
        if (body.routingFetchFailed) {
          provisionMsg = 'Provisioned ⚠';
          provisionWarning = body.message;
        } else {
          provisionMsg = 'Provisioned!';
        }
        setTimeout(() => invalidateAll(), 1500);
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
    const ok = await confirmAction({
      title: 'Prune this worker?',
      body: 'Removes unused images, stopped containers, unused volumes and networks. Anything still in use is kept.',
      confirmLabel: 'Prune',
      danger: true,
    });
    if (!ok) return;
    pruning = true;
    try {
      const res = await fetch(`/api/workers/${workerId}/prune`, { method: 'POST' });
      const body = await res.json();
      if (body.success) {
        showToast('success', 'Prune completed');
        setTimeout(() => invalidateAll(), 800);
      } else {
        showToast('error', body.error || 'Prune failed');
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
      oidcCallbackPath = body.oidcCallbackPath ?? '/oidc/callback';
      oidcCallbackHost = body.callbackHost ?? '';
      oidcCallbackUrl = body.callbackUrl ?? '';
      oidcLoaded = true;
    } catch { /* ignore */ }
  }

  async function saveOidcSettings() {
    oidcSaving = true;
    oidcSaveMsg = '';
    try {
      const payload: Record<string, any> = {
        oidcEnabled,
        oidcProviderUrl,
        oidcClientId,
        oidcCallbackPath,
      };
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
      // The server stores the issuer, so a pasted discovery URL comes back
      // shortened. Show what was saved rather than what was typed.
      const providerUrlBefore = oidcProviderUrl;
      oidcProviderUrl = data.oidcProviderUrl ?? oidcProviderUrl;
      const providerUrlTrimmed = providerUrlBefore !== oidcProviderUrl;
      oidcCallbackPath = data.oidcCallbackPath ?? oidcCallbackPath;
      oidcCallbackHost = data.callbackHost ?? oidcCallbackHost;
      oidcCallbackUrl = data.callbackUrl ?? oidcCallbackUrl;
      oidcClientSecret = '';
      const trimmedNote = providerUrlTrimmed
        ? 'Provider URL shortened to the issuer — the plugin appends the discovery path itself. '
        : '';
      oidcSaveMsg = trimmedNote + (routingMode === 'http'
        ? 'Saved. The worker picks this up on its next fetch — within about ten seconds.'
        : 'Saved. Now click “Apply to Traefik” — deployments stay blocked until the config reaches the worker.');
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

  async function loadConfigAuth() {
    try {
      const res = await fetch(`/api/workers/${workerId}/config-auth`);
      if (!res.ok) return;
      const body = await res.json();
      basicUser = body.configBasicUser ?? '';
      basicPasswordSet = body.configBasicPasswordSet ?? false;
    } catch { /* ignore */ }
  }

  async function saveConfigAuth() {
    basicSaving = true;
    basicMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/config-auth`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configBasicUser: basicUser, configBasicPassword: basicPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Save failed');
      basicUser = body.configBasicUser ?? '';
      basicPasswordSet = body.configBasicPasswordSet ?? false;
      basicPassword = '';
      basicMsg = body.message || 'Saved.';
    } catch (e: any) {
      basicMsg = 'Error: ' + e.message;
    } finally {
      basicSaving = false;
    }
  }

  async function clearConfigAuth() {
    const ok = await confirmAction({
      title: 'Remove control-plane credentials?',
      body: 'The worker keeps presenting the old ones until it is re-provisioned.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    basicSaving = true;
    basicMsg = '';
    try {
      const res = await fetch(`/api/workers/${workerId}/config-auth`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      basicUser = '';
      basicPassword = '';
      basicPasswordSet = false;
      basicMsg = body.message || 'Removed.';
    } catch (e: any) {
      basicMsg = 'Error: ' + e.message;
    } finally {
      basicSaving = false;
    }
  }

  async function clearOidcSettings() {
    const ok = await confirmAction({
      title: 'Remove OIDC configuration?',
      body: 'Applications set to "Default" auth will become public on this worker.',
      confirmLabel: 'Remove OIDC',
      danger: true,
    });
    if (!ok) return;
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
    const ok = await confirmAction({
      title: `Delete worker "${data.worker.name}"?`,
      body: 'This removes it from Rudder. Containers already running on the host are not touched, and Rudder will stop managing them.',
      confirmLabel: 'Delete worker',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/workers/${workerId}`, { method: 'DELETE' });
      const body = await res.json();
      if (res.ok) {
        window.location.href = '/workers';
      } else {
        showToast('error', body.error || 'Delete failed');
      }
    } catch (e: any) {
      showToast('error', e.message);
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

  /**
   * What a chart's numbers are, so the axis can say so.
   *
   * This used to be a free-form string that only `'%'` was ever checked
   * against, so everything else fell through to the byte formatter — and the
   * container-count chart announced `8.8 B` on its axis and `Running: 2 B` in
   * its legend.
   */
  type ChartUnit = 'percent' | 'bytes' | 'count';

  function formatChartValue(value: number, unit: ChartUnit): string {
    if (unit === 'percent') return value.toFixed(1) + '%';
    // formatBytes reports nothing for a falsy value, which is right for a
    // missing measurement and wrong for an axis: the baseline is zero bytes.
    if (unit === 'bytes') return value <= 0 ? '0 B' : formatBytes(value);
    return Math.round(value).toString();
  }

  // Chart component for multiple series
  function chart(
    series: { values: (number | null)[]; color: string; label: string }[],
    width = 600,
    height = 120,
    unit: ChartUnit = 'bytes'
  ): string {
    const allNums = series.flatMap(s => s.values.filter((v): v is number => v != null && !isNaN(v)));
    if (allNums.length < 2) return '<p class="chart-empty">No data collected yet</p>';
    const min = 0;
    const rawMax = Math.max(...allNums);

    // Counts get a whole-numbered axis with a step that divides evenly. The
    // shared `* 1.1` headroom is what produced ticks like 6.6000000000000005 —
    // meaningless for a quantity that only comes in ones.
    let max: number;
    let divisions: number;
    if (unit === 'count') {
      const tick = Math.max(1, Math.ceil(Math.max(rawMax, 1) / 4));
      divisions = Math.ceil(Math.max(rawMax, 1) / tick);
      max = tick * divisions;
    } else {
      max = rawMax * 1.1 || 1;
      // The 10% headroom put "102.9%" at the top of a CPU chart. A percentage
      // of a host's capacity does not go above 100.
      if (unit === 'percent') max = Math.min(100, max);
      divisions = 4;
    }

    const labels: string[] = [];
    let paths = '';

    for (const s of series) {
      const nums = s.values.filter((v): v is number => v != null && !isNaN(v));
      if (nums.length < 2) continue;
      const step = width / (nums.length - 1);
      const pts = nums.map((v, i) => `${i * step},${height - ((v - min) / (max - min)) * (height - 16) - 8}`).join(' ');
      paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.5" />`;
      const latest = nums[nums.length - 1];
      labels.push(`<span style="color:${s.color}">${s.label}: ${latest != null ? formatChartValue(latest, unit) : '—'}</span>`);
    }

    // Grid lines
    let grid = '';
    for (let i = 0; i <= divisions; i++) {
      const y = 8 + (i / divisions) * (height - 16);
      const val = max - (i / divisions) * max;
      grid += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#303744" stroke-width="0.5" />`;
      grid += `<text x="${width + 4}" y="${y + 3}" fill="#7a8494" font-size="9">${formatChartValue(val, unit)}</text>`;
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
  <PageHeader title={data.worker.name} back={{ href: '/workers', label: 'Workers' }}>
    {#snippet badge()}
      <span class="status-badge {data.worker.status}">{data.worker.status}</span>
    {/snippet}

    {#snippet meta()}
      <div class="meta-row">
        <span class="meta">{data.worker.hostname}:{data.worker.sshPort}</span>
        {#if data.worker.baseDomain}
          <span class="meta mono">*.{data.worker.baseDomain}</span>
        {/if}
      </div>
    {/snippet}

    {#snippet actions()}
      <button class="btn-tiny btn-accent" disabled={provisioning} onclick={requestProvision} title="Re-run provisioning script on this worker (reinstalls Podman, Traefik, CrowdSec)">
        {provisioning ? 'Re-provisioning…' : (provisionMsg || 'Re-provision')}
      </button>
      <button class="btn-tiny" onclick={collectMetrics} title="Manually collect worker and container metrics">{collectMsg || 'Collect Now'}</button>
      <a href="/workers/{data.worker.id}/edit" class="btn-tiny" title="Edit worker configuration">Edit</a>
      <button class="btn-tiny btn-prune" disabled={pruning} onclick={pruneSystem} title="Prune unused images, containers, volumes, and networks">
        {pruning ? 'Pruning…' : 'Prune'}
      </button>
      <button class="btn-tiny btn-delete" onclick={deleteWorker} title="Delete this worker">Delete</button>
    {/snippet}
  </PageHeader>

  {#if provisionWarning}
    <div class="provision-warning" role="alert">
      <strong>Routing configuration was not fetched.</strong>
      <p>{provisionWarning}</p>
      <button class="btn-tiny" onclick={() => provisionWarning = ''}>Dismiss</button>
    </div>
  {/if}

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
      <div class="stat-value">{data.metrics.length > 0 ? timeAgo(data.metrics[0]?.collectedAt, 'short') : '—'}</div>
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
              <!-- One statement, not two. `runningVersion ?? 'unknown'` and the
                   badge both fired when the version could not be read, so the
                   row said "unknown version unknown". -->
              <span class="cfg-value">
                {#if comp.runningVersion}
                  {comp.runningVersion}
                  {#if comp.upToDate === false}
                    <span class="patch-warn" title={`Re-provisioning would install ${comp.expectedImage}`}>
                      → {comp.expectedVersion}
                    </span>
                  {/if}
                {:else}
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
            600, 120, 'percent'
          )}
        </div>
        <div class="section">
          <h3>Memory Usage</h3>
          {@html chart(
            [{ values: m.map((pt: any) => pt.memPercent).reverse(), color: '#3fb950', label: 'Memory' }],
            600, 120, 'percent'
          )}
        </div>
        <div class="section">
          <h3>Containers</h3>
          {@html chart(
            [
              { values: m.map((pt: any) => pt.containersRunning).reverse(), color: '#3fb950', label: 'Running' },
              { values: m.map((pt: any) => pt.containersTotal).reverse(), color: '#7a8494', label: 'Total' },
            ],
            600, 120, 'count'
          )}
        </div>
        <div class="section">
          <h3>Disk Usage</h3>
          {@html chart(
            [
              { values: m.map((pt: any) => pt.diskUsageBytes).reverse(), color: '#38bdf8', label: 'Podman Used' },
              { values: m.map((pt: any) => pt.diskLimitBytes).reverse(), color: '#7a8494', label: 'Host Total' },
            ],
            600, 120, 'bytes'
          )}
        </div>
        <div class="section">
          <h3>Network I/O</h3>
          {@html chart(
            [
              { values: m.map((pt: any) => pt.netRxBytes).reverse(), color: '#58a6ff', label: 'RX' },
              { values: m.map((pt: any) => pt.netTxBytes).reverse(), color: '#f0883e', label: 'TX' },
            ],
            600, 120, 'bytes'
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
        <div class="empty-row">
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
              <span class="event-time">{ev.time ? timeAgo(ev.time * 1000, 'short') : (ev.timeNano ? timeAgo(ev.timeNano / 1e6, 'short') : '—')}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

  <!-- Containers tab -->
  {:else if activeTab === 'containers'}
    <!-- Adoption. Rudder used to walk a re-provisioned worker and import
         whatever it found, reverse-engineering configuration out of Traefik
         labels. Now it asks. -->
    <div class="section">
      <div class="section-header">
        <h3>Adopt existing containers</h3>
        <button class="btn-tiny" onclick={loadAdoptable} disabled={adoptLoading} title="List containers on this worker that Rudder does not manage">
          {adoptLoading ? 'Scanning…' : adoptLoaded ? 'Rescan' : 'Scan for containers'}
        </button>
      </div>
      {#if adoptMsg}
        <p class="adopt-msg">{adoptMsg}</p>
      {/if}
      {#if adoptLoaded && adoptable.length === 0}
        <p class="empty">Every container on this worker is already managed by Rudder.</p>
      {:else if adoptable.length > 0}
        <p class="help-text">
          Adopting a container records it as an application so it can be redeployed and
          reconciled. It cannot add Rudder's ownership label — Podman fixes labels when a
          container is created — so an adopted container is never removed by the reconciler
          until its first deploy. Authentication and rate limits start empty; a secret that
          only existed in the container's labels cannot be recovered.
        </p>
        <div class="adopt-list">
          {#each adoptable as c}
            <div class="adopt-row">
              <label class="adopt-check">
                <input type="checkbox" bind:checked={adoptPick[c.containerId].selected} />
                <code>{c.name}</code>
              </label>
              <span class="status-badge {c.status}">{c.status}</span>
              <span class="adopt-image">{c.image}</span>
              <input
                class="adopt-input"
                bind:value={adoptPick[c.containerId].name}
                placeholder="Application name"
                title="Name for the application Rudder will create"
              />
              <select class="adopt-input" bind:value={adoptPick[c.containerId].teamId} title="Team that will own this application">
                <option value="">No team</option>
                {#each data.teams as t}
                  <option value={t.id}>{t.name}</option>
                {/each}
              </select>
              <span class="adopt-domain">{c.domain ?? 'not routed'}</span>
            </div>
          {/each}
        </div>
        <button class="btn-tiny btn-primary-tiny" onclick={adoptSelected} disabled={adopting} title="Create applications for the selected containers">
          {adopting ? 'Adopting…' : 'Adopt selected'}
        </button>
      {/if}
    </div>

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
          {#if traefik.image}
            <div class="cfg"><span class="cfg-label">Image</span><span class="cfg-value mono">{traefik.image}</span></div>
          {/if}
          {#if traefik.startedAt}
            <div class="cfg"><span class="cfg-label">Started</span><span class="cfg-value">{new Date(traefik.startedAt).toLocaleString()}</span></div>
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
          {#if crowdsec.image}
            <div class="cfg"><span class="cfg-label">Image</span><span class="cfg-value mono">{crowdsec.image}</span></div>
          {/if}
          {#if crowdsec.startedAt}
            <div class="cfg"><span class="cfg-label">Started</span><span class="cfg-value">{new Date(crowdsec.startedAt).toLocaleString()}</span></div>
          {/if}
          <div class="cfg">
            <span class="cfg-label">Bouncer Key</span>
            <span class="cfg-value">{crowdsec.bouncerKeyConfigured ? 'Configured' : 'Not configured'}</span>
          </div>
        </div>
      </div>

      <!-- Active Decisions -->
      <div class="section">
        <div class="section-head">
          <h3>
            Active Decisions{crowdsec.decisionsAvailable && crowdsec.decisions.length > 0
              ? ` (${crowdsec.decisions.length})`
              : ''}
          </h3>
          <button class="btn-tiny" onclick={loadCrowdsec} title="Re-read decisions from CrowdSec">Refresh</button>
        </div>

        {#if !crowdsec.decisionsAvailable}
          <!-- Never "all clear" on the strength of an unanswered question: this
               panel used to say exactly that while three bans were live.
               `decisionsError` says which failure it was, because this one is
               intermittent and "could not read decisions" alone left an
               operator with nothing to report and nowhere to look. -->
          <p class="error">
            Could not read decisions from CrowdSec on this worker. Bans may be
            active and are not shown here.
          </p>
          {#if crowdsec.decisionsError}
            <p class="help-text mono small">{crowdsec.decisionsError}</p>
          {/if}
        {:else if crowdsec.decisions.length === 0}
          <p class="empty">No active decisions — all clear</p>
        {:else}
          <p class="help-text">
            A ban is by source address and applies to every application on this worker, so an
            address banned while testing one application loses all of them. Removing a decision
            takes effect immediately; CrowdSec will re-apply it if the same behaviour repeats.
          </p>
          <table class="mini-table">
            <thead><tr><th>Address</th><th>Origin</th><th>Reason</th><th>Action</th><th>Expires in</th><th></th></tr></thead>
            <tbody>
              {#each crowdsec.decisions as d}
                <tr>
                  <td>
                    <span class="mono small">{d.value || '—'}</span>
                    <!-- Country and network are what tell your own office
                         address apart from a bot in someone's cloud. -->
                    {#if d.country || d.asName}
                      <span class="decision-origin">
                        {[d.country, d.asName].filter(Boolean).join(' · ')}
                      </span>
                    {/if}
                  </td>
                  <td>{d.source || '—'}</td>
                  <td>{d.reason || '—'}</td>
                  <td>{d.type || '—'}</td>
                  <td>{d.duration || '—'}</td>
                  <td>
                    <button
                      class="btn-tiny btn-danger"
                      disabled={removingDecision === d.id}
                      onclick={() => removeDecision(d)}
                      title="Lift this decision on the worker"
                    >
                      {removingDecision === d.id ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}

        {#if decisionError}
          <p class="error">{decisionError}</p>
        {/if}
      </div>

      <!-- Which rules actually fired, and against what -->
      {#if crowdsec.appsecAlerts?.length}
        <div class="section">
          <div class="section-head">
            <h3>WAF matches by source ({crowdsec.appsecAlerts.length})</h3>
          </div>
          <p class="help-text">
            The rules that scored, and how often. <strong>This, not the Reason column above, is
            what to disable</strong> — a decision names the first rule in the chain, which is
            usually a CRS initialisation rule that does nothing when switched off. The rule with
            the highest count against an address is the one breaking it.
          </p>
          <p class="help-text">
            Each rule can be disabled <strong>for all traffic</strong> or <strong>only for this
            address</strong>. Prefer the second when one caller is the only thing tripping it: the
            rule keeps protecting the application against everyone else.
          </p>
          <p class="help-text">
            An application's own page shows the same thing for that application alone, and its
            team can act on it there without access to this worker.
          </p>
          <p class="help-text">
            Most CRS rules only add to an anomaly score; <strong><code>949110</code> is the one
            that fires when the total crosses the threshold</strong>, and the only one that
            enforces anything. Excluding it would not narrow the ruleset for an application, it
            would turn CRS off for it — so it cannot be excluded, and neither can the setup and
            reporting rules, which would stop nothing. Those are shown in amber and are not
            clickable. Exclude the signatures that pushed the score over instead.
          </p>
          <p class="help-text">
            Excluding a rule applies to that application on every port it serves, takes effect
            within a minute, and restarts CrowdSec on this worker. Only exclude rules firing on
            traffic you recognise: an attack looks much like a false positive from here, and the
            path is the thing that tells them apart.
          </p>
          <AppsecMatches
            sources={crowdsec.appsecAlerts}
            canExclude={true}
            onExclude={excludeRule}
            busyRule={excludingRule}
          />
          {#if ruleMessage}
            <p class={ruleError ? 'error' : 'help-text'}>{ruleMessage}</p>
          {/if}
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
            <p class="routing-status"
               class:is-stale={fetchFailing || !configFetchedAt || Date.now() - new Date(configFetchedAt).getTime() > 60000}>
              {#if fetchFailing}
                {#if fetchStatus === 0}
                  Fetch failing — the worker cannot reach the control plane{fetchAttemptAt ? ` (last tried ${new Date(fetchAttemptAt).toLocaleString()})` : ''}.
                {:else}
                  Fetch failing — HTTP {fetchStatus}{fetchAttemptAt ? ` as of ${new Date(fetchAttemptAt).toLocaleString()}` : ''}.
                {/if}
                {fetchFailureHint}
                {#if configFetchedAt}
                  Last successful fetch {new Date(configFetchedAt).toLocaleString()}.
                {:else}
                  It has never fetched successfully, so its applications are still served by whatever routed them before the switch.
                {/if}
              {:else if configFetchedAt}
                Last fetched {new Date(configFetchedAt).toLocaleString()}
              {:else}
                No fetch reported yet. If the worker has not been provisioned since the switch, re-provision it to
                install the fetch timer; otherwise it reports its next attempt within a metrics cycle.
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

      <div class="subsection">
        <h4>Control-plane Basic authentication</h4>
        <p class="oidc-intro">
          Only needed when Rudder is published behind a proxy that demands its own HTTP Basic credentials. That
          proxy answers this worker's fetch with <code class="mono-inline">401</code> before Rudder sees it, so the
          worker's own token never gets checked and re-provisioning cannot help. Leave blank if there is no such
          proxy — exempting <code class="mono-inline">/api/workers/*/traefik-config</code> at the proxy is the
          better fix where you control it, because it keeps one credential in play instead of two.
        </p>

        <div class="form-row-2">
          <div class="form-field">
            <label for="basicUser">Username</label>
            <input type="text" id="basicUser" autocomplete="off"
              placeholder="none" bind:value={basicUser} />
          </div>
          <div class="form-field">
            <label for="basicPassword">Password</label>
            <input type="password" id="basicPassword" autocomplete="new-password"
              placeholder={basicPasswordSet ? '••••• (saved — paste to replace)' : 'proxy password'}
              bind:value={basicPassword} />
            {#if basicPasswordSet && !basicPassword}
              <p class="field-hint">A password is saved. Leave blank to keep it.</p>
            {/if}
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" onclick={saveConfigAuth} disabled={basicSaving}>
            {basicSaving ? 'Saving…' : 'Save credentials'}
          </button>
          {#if basicUser || basicPasswordSet}
            <button class="btn btn-outline-danger" onclick={clearConfigAuth} disabled={basicSaving}>Remove</button>
          {/if}
        </div>

        {#if basicMsg}
          <p class="settings-msg" class:is-error={basicMsg.startsWith('Error')}>{basicMsg}</p>
        {/if}
      </div>
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
              <p class="field-hint">
                The provider's <strong>issuer</strong> URL — not the discovery document. Traefik appends
                <code class="mono-inline">/.well-known/openid-configuration</code> itself, so a URL ending in that
                path is shortened on save. For Keycloak this is
                <code class="mono-inline">https://host/realms/&lt;realm&gt;</code>.
              </p>
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
              <label for="oidcCallbackPath">Callback Path</label>
              <input type="text" id="oidcCallbackPath"
                placeholder="/oidc/callback"
                bind:value={oidcCallbackPath} />
              <p class="field-hint">
                Path of the shared callback on <code class="mono-inline">{oidcCallbackHost || 'auth.<base domain>'}</code>.
                Change it only to match what your identity provider already has registered — providers compare
                redirect URIs by exact string, and <code class="mono-inline">/oauth2/callback</code> is the other
                common convention. Leave blank for the default.
              </p>
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

  .error { color: var(--red-text); font-size: 13px; }
  .empty {
    color: var(--text-muted); font-size: 13px; font-style: italic;
    text-align: center; padding: 24px;
  }

  .empty-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .empty-row .empty { padding: 0 0 16px 0; }

  .patch-warn { color: var(--yellow-text, var(--accent)); font-weight: 600; }
  .patch-unknown { color: var(--text-muted); font-style: italic; }

  /* ── Adoption ──────────────────────────────────── */

  .help-text {
    line-height: 1.5;
    margin: 0 0 12px;
  }
  .adopt-msg { font-size: 12px; color: var(--text-primary); margin: 0 0 10px; }
  .adopt-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .adopt-row {
    display: grid;
    grid-template-columns: minmax(160px, 1.4fr) auto minmax(120px, 1.2fr) minmax(120px, 1fr) minmax(110px, 1fr) minmax(120px, 1fr);
    align-items: center; gap: 8px;
    padding: 7px 9px; font-size: 12px;
    background: var(--bg-overlay); border-radius: var(--radius-sm);
  }
  .adopt-check { display: flex; align-items: center; gap: 7px; cursor: pointer; min-width: 0; }
  .adopt-check code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adopt-image, .adopt-domain {
    color: var(--text-muted); font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .adopt-input {
    background: var(--bg-input); color: var(--text-primary);
    border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    padding: 3px 6px; font-size: 11.5px; min-width: 0;
  }
  .btn-primary-tiny { border-color: var(--accent); color: var(--accent); }

  /* One column per row below the point where six of them stop being readable. */
  @media (max-width: 900px) {
    .adopt-row { grid-template-columns: 1fr; }
  }

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

  /* Secondary to the address it sits under, not a column of its own. */
  .decision-origin {
    display: block; font-size: 10px; color: var(--text-muted); margin-top: 2px;
  }
  /* One clickable rule id. Deliberately quiet: the common case is reading these,
     not clicking them, and a row of buttons that look like actions invites
     switching rules off before anyone has read the path they fired on. */
  .rule-chip {
    display: inline-block; margin: 1px 3px 1px 0; padding: 1px 6px;
    font-family: var(--font-mono); font-size: 10px;
    color: var(--text-secondary); background: var(--bg-overlay);
    border: 1px solid var(--border-default); border-radius: 3px; cursor: pointer;
  }
  .rule-chip:hover:not(:disabled) {
    color: var(--text-primary); border-color: var(--text-muted);
  }
  .rule-chip:disabled { opacity: 0.5; cursor: default; }
  /* What the rule is for. A bare id is a number to go and look up; "Path
     Traversal Attack" is a judgement someone can make about their own app. */
  .rule-why {
    margin-left: 5px; font-family: var(--font-sans);
    color: var(--text-muted); font-size: 10px;
  }
  /* Score machinery, not a signature. Excluding 949110 disables CRS for the
     host outright, and it is the id most likely to be clicked because it is the
     one reported as firing — so it must not look like its neighbours. */
  .rule-chip--meta {
    color: var(--warning, #d29922);
    border-color: var(--warning, #d29922);
    border-style: dashed;
  }
  /* The path is the evidence; it is also frequently a 200-character signed URL. */
  .path-cell {
    display: inline-block; max-width: 380px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
  }
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

  /* ── Settings tab ────────────────────────────── */
  .settings-form { display: flex; flex-direction: column; gap: 16px; }
  .form-field { display: flex; flex-direction: column; gap: 4px; }
  .form-field label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .form-field input[type='text'],
  .form-field input[type='url'],
  .form-field input[type='password'] {
    padding: 8px 10px; background: var(--bg-overlay, rgba(0,0,0,0.2));
    border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary); font-size: 0.9rem; width: 100%;
  }
  .form-field input:disabled { opacity: 0.55; cursor: not-allowed; }
  .form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .toggle-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.92rem; font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--text-primary); }
  .toggle-label input[type='checkbox'] { width: 16px; height: 16px; cursor: pointer; }
  .oidc-fields { display: flex; flex-direction: column; gap: 14px; padding: 16px; background: var(--bg-overlay, rgba(0,0,0,0.1)); border-radius: 8px; border: 1px solid var(--border-default); }
  .field-hint { font-size: 11px; color: var(--text-muted); margin: 2px 0 0; }
  .oidc-intro { font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 4px; }
  .oidc-prereq {
    margin: 12px 0 16px;
    padding: 14px 16px;
    border: 1px solid var(--border-default);
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
    border: 1px solid var(--border-default);
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
  .routing-status { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
  .routing-status.is-stale { color: var(--warning, #e0a030); }
  .provision-warning {
    margin: 12px 0;
    padding: 12px 14px;
    border-radius: 6px;
    background: rgba(224, 160, 48, 0.08);
    border: 1px solid rgba(224, 160, 48, 0.28);
    color: var(--text-primary);
    font-size: 0.87rem;
  }
  .provision-warning p { margin: 6px 0 10px; line-height: 1.5; }
  .subsection { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border, rgba(255,255,255,0.08)); }
  .subsection h4 { margin: 0 0 6px; font-size: 0.95rem; }
  .mono-inline { font-family: var(--font-mono); font-size: 12px; background: var(--bg-overlay, rgba(0,0,0,0.2)); padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; word-break: break-all; }
  .req { color: var(--red, #f87171); }
  .form-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding-top: 4px; }
  .btn { padding: 7px 16px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; font-size: 0.88rem; font-weight: 500; transition: all 0.15s; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary:hover:not(:disabled) { opacity: 0.88; }
  .btn-secondary:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .btn-outline-danger { background: transparent; color: var(--red-text, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
  .btn-outline-danger:hover { background: var(--red-subtle, rgba(248,113,113,0.1)); border-color: var(--red, #f87171); }
  .settings-msg { margin-top: 4px; padding: 8px 12px; border-radius: 6px; font-size: 0.87rem; background: rgba(50,200,100,0.08); color: var(--text-primary); border: 1px solid rgba(50,200,100,0.2); }
  .settings-msg.is-error { background: rgba(200,50,50,0.08); color: var(--red-text, #f87171); border-color: rgba(200,50,50,0.2); }
  .help-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: 4px; }
  .help-item { display: flex; gap: 12px; align-items: flex-start; }
  .help-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
  .help-item strong { display: block; font-size: 13px; margin-bottom: 2px; }
  .help-item p { font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.4; }
</style>
