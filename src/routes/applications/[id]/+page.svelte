<script lang="ts">
  import Modal from '$lib/components/Modal.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { formatBytes, formatTime } from '$lib/format';
  import { invalidateAll } from '$app/navigation';
  import ContainerTerminal from '$lib/components/ContainerTerminal.svelte';
  import YamlEditor from '$lib/components/YamlEditor.svelte';
  import { showToast } from '$lib/client/toast.svelte';
  import { confirmAction, type ConfirmRequest } from '$lib/client/dialog.svelte';
  import { lifecycleControls, lifecycleLabel } from '$lib/client/lifecycle-controls';
  import AppsecMatches from '$lib/components/AppsecMatches.svelte';

  /**
   * Deploy errors and deployment notes, shown properly.
   *
   * These were handed to `alert()`, which renders multi-paragraph prose as one
   * unwrapped wall of text and is suppressed entirely in some browsers — so the
   * notes explaining why a manifest was reinterpreted could not be read at all.
   */
  let detail = $state<{ title: string; paragraphs: string[] } | null>(null);

  function showDetail(title: string, paragraphs: string[]) {
    detail = { title, paragraphs };
  }

  let { data } = $props();
  let activeTab = $state('containers');
  let deploying = $state(false);

  // ── Drift ──────────────────────────────────────────────────────────────────
  //
  // What the last reconciliation pass found for this application. Reported, never
  // corrected on its own: the pass is read-only, so anything shown here is
  // waiting on a person.
  interface Drift {
    kind: 'missing' | 'stale' | 'unhealthy' | 'orphan' | 'foreign' | 'retained' | 'unreaped';
    name: string;
    detail: string;
  }
  // Null until a re-check replaces it, so the page keeps following the server's
  // answer — which is refreshed on every navigation — rather than freezing
  // whatever it happened to load with.
  let recheckedDrift = $state<Drift[] | null>(null);
  const drift = $derived(recheckedDrift ?? data.drift ?? []);
  let reconciling = $state(false);
  let rechecking = $state(false);

  // A retained previous version is not a problem, and the panel below is styled
  // to look like one. Split so the warning stays a warning: an application with
  // a fast-rollback window would otherwise spend every window announcing that it
  // had drifted, which is how a panel gets ignored.
  const problems = $derived(drift.filter((d) => d.kind !== 'retained'));
  const notices = $derived(drift.filter((d) => d.kind === 'retained'));

  const DRIFT_LABEL: Record<Drift['kind'], string> = {
    missing: 'Not running',
    stale: 'Out of date',
    unhealthy: 'Failing health check',
    orphan: 'Untracked',
    foreign: 'Not managed by Rudder',
    retained: 'Previous version',
    unreaped: 'Should have been removed',
  };

  /** Why the last check could not run, if it could not. */
  let driftError = $state<string | null>(null);

  /**
   * Recompute the diff now and adopt the answer.
   *
   * Returns the findings, or null when the check itself failed. The endpoint
   * stores what it computes, so calling this also brings the snapshot that the
   * page load reads up to date — which is what lets an action refresh the panel
   * by running this before reloading.
   */
  async function runDriftCheck(): Promise<Drift[] | null> {
    try {
      const res = await fetch(`/api/applications/${data.application.id}/reconcile`);
      const body = await res.json();
      if (!res.ok) {
        driftError = body.error || 'Could not check for drift';
        return null;
      }
      driftError = null;
      recheckedDrift = body.drift ?? [];
      return recheckedDrift;
    } catch (e: any) {
      driftError = e.message;
      return null;
    }
  }

  /** Re-run the diff now rather than waiting for the next collection cycle. */
  async function recheckDrift() {
    rechecking = true;
    try {
      const found = await runDriftCheck();
      if (found === null) {
        showToast('error', driftError || 'Could not check for drift');
      } else {
        // Counted without the retained previous version. It is reported, but it
        // is not a difference from the configuration — calling it one told
        // someone with a healthy application that it had drifted.
        const count = found.filter((d) => d.kind !== 'retained').length;
        showToast('success', count === 0 ? 'No drift — this application matches its configuration' : `${count} difference${count === 1 ? '' : 's'} found`);
      }
    } finally {
      rechecking = false;
    }
  }

  /**
   * Reload the page after something changed the containers, with the drift
   * check re-run first.
   *
   * The panel reads the last stored reconciliation pass, so reloading straight
   * after a deploy re-rendered the timer's pre-deploy answer — it claimed the
   * container was still exited while the Containers tab showed it running.
   * Recomputing first replaces that snapshot, so the two agree.
   */
  function reloadWithFreshDrift(delayMs = 800) {
    setTimeout(async () => {
      await runDriftCheck();
      invalidateAll();
    }, delayMs);
  }

  /**
   * Correct the drift by deploying.
   *
   * There is no separate repair path on purpose. A deploy already creates what
   * is absent, replaces what was built from different configuration, and verifies
   * the result before routing to it.
   */
  async function reconcileNow() {
    reconciling = true;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/reconcile`, { method: 'POST' });
      const body = await res.json();
      if (res.ok) {
        showToast('success', body.message || 'Reconciled');
        reloadWithFreshDrift();
      } else {
        showToast('error', body.error || 'Reconcile failed');
      }
    } catch (e: any) {
      showToast('error', e.message);
    } finally {
      reconciling = false;
    }
  }

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
    const ok = await confirmAction({
      title: 'Delete this deploy webhook?',
      body: 'Any CI/CD pipeline using it will stop working. A new webhook gets a new token.',
      confirmLabel: 'Delete webhook',
      danger: true,
    });
    if (!ok) return;
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


  // ── Deployment history ────────────────────────────────────────────────────
  interface Deployment {
    id: string;
    version: number;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    image: string | null;
    /**
     * What actually ran: a `repo@sha256:…` reference, or a JSON map of them
     * for multi-service applications. Null for deployments recorded before
     * digests were tracked — those roll back by tag, as they always did.
     */
    imageDigest: string | null;
    /**
     * This version's containers are still on the worker, stopped, so rolling
     * back to it restarts them instead of pulling and recreating. Only ever
     * true while the application's retention window is open.
     */
    fastRollback: boolean;
    deployedBy: string | null;
    deployedByName: string | null;
    errorMessage: string | null;
    /**
     * What this deploy did not do exactly as the manifest asked — a Kubernetes
     * semantic that does not survive translation to containers on a bridge, a
     * field Rudder ignores. Not errors; the deploy succeeded.
     */
    notes: string[];
    createdAt: string;
    finishedAt: string | null;
  }
  /**
   * Render a stored digest record for a table cell: `sha256:1a2b3c4d…`, or a
   * count when the application has one digest per service and listing them all
   * would swamp the row. The full value is in the cell's title attribute.
   */
  function shortDigest(raw: string): string {
    if (raw.trim().startsWith('{')) {
      try {
        const n = Object.keys(JSON.parse(raw)).length;
        return `${n} pinned image${n === 1 ? '' : 's'}`;
      } catch {
        return 'digest recorded';
      }
    }
    const at = raw.indexOf('@');
    const digest = at === -1 ? raw : raw.slice(at + 1);
    return digest.length > 21 ? `${digest.slice(0, 21)}…` : digest;
  }

  let deploymentsList = $state<Deployment[]>([]);

  /**
   * The deployment actually serving traffic: the newest one that finished
   * successfully. A rollback writes its own row with status `rolled_back`, and
   * that row is what runs afterwards, so it counts as current too.
   *
   * The badge used to follow the newest row whatever its status, so a failed
   * deploy was labelled CURRENT while the previous version carried on serving —
   * exactly backwards, on the screen someone reads during an incident.
   */
  const currentDeploymentId = $derived(
    deploymentsList.find((d) => d.status === 'succeeded' || d.status === 'rolled_back')?.id ?? null,
  );

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
    // Two very different operations behind one button. Saying which one is
    // about to happen matters most during an incident, which is when this
    // button gets pressed.
    const what = dep.fastRollback
      ? `Version ${dep.version} is still on the worker, stopped. Rolling back restarts those ` +
        `containers and moves traffic to them — a few seconds, no image pull.`
      : `This redeploys the application from that version's configuration: the image is pulled ` +
        `and the containers are recreated, which takes as long as a normal deploy.`;
    const ok = await confirmAction({
      title: `Roll back to version ${dep.version}?`,
      body: what,
      confirmLabel: dep.fastRollback ? 'Roll back (instant)' : 'Roll back',
    });
    if (!ok) return;
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
        reloadWithFreshDrift();
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

  // ── Web firewall ──────────────────────────────────────────────────────────
  //
  // The same evidence the worker page shows, scoped to this application and
  // authorised on it. The worker page is admin-only, so the team that owns an
  // application — the only people who can say whether a match is their own
  // legitimate traffic — could not see any of it, and could not act on it.
  let appsec = $state<any>(null);
  let appsecLoading = $state(false);
  let excludingRule = $state<string | null>(null);
  let appsecMessage = $state('');
  let appsecError = $state(false);

  async function loadAppsec() {
    appsecLoading = true;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/appsec`);
      appsec = await res.json();
    } catch (e: any) {
      appsec = { sources: [], available: false, error: e.message };
    } finally {
      appsecLoading = false;
    }
  }

  async function excludeAppsecRule(host: string, rule: string, source?: string) {
    const scope = source
      ? `only for requests from ${source}. The rule keeps protecting this application ` +
        `against every other address.`
      : `for all traffic. It stops protecting this application against everyone, on every ` +
        `port it serves.`;
    if (!confirm(`Stop rule ${rule} firing for ${host}?\n\nDisabled ${scope}\n\n` +
      `The change takes effect within a minute.`)) return;

    appsecMessage = '';
    appsecError = false;
    excludingRule = `${host}|${rule}${source ? `@${source}` : ''}`;
    try {
      const res = await fetch('/api/applications/appsec-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, rule, source }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        appsecError = true;
        appsecMessage = body.error || `Could not disable rule ${rule}.`;
      } else if (body.added === false) {
        appsecMessage = `Rule ${rule} was already disabled for this application.`;
      } else {
        appsecMessage =
          `Rule ${rule} disabled${source ? ` for ${source}` : ''}. ` +
          `The worker applies it within a minute.`;
        // Re-read so the row marks itself disabled. Otherwise it still offers
        // "Disable", which reads as the click having failed.
        await loadAppsec();
      }
    } catch (e: any) {
      appsecError = true;
      appsecMessage = e.message;
    } finally {
      excludingRule = null;
    }
  }

  $effect(() => {
    if (activeTab === 'firewall' && appsec === null && !appsecLoading) loadAppsec();
  });

  // ── Storage ───────────────────────────────────────────────────────────────
  //
  // Every volume the application uses, whatever it was deployed from. The
  // volume registry only ever reached single-container applications, so a
  // compose file's storage — real Podman volumes, named by Rudder, holding data
  // across redeploys — had no representation anywhere in the UI at all. The
  // server derives this from the same intent a deploy acts on; see
  // `appStorage`.
  interface VolumeCopy {
    name: string;
    /** Epoch milliseconds, read back out of the copy's own name. */
    at: number;
    sizeBytes: number | null;
  }
  interface AppVolume {
    name: string;
    label: string;
    origin: 'registry' | 'app-scoped' | 'shared' | 'foreign';
    declared: boolean;
    present: boolean;
    sizeBytes: number | null;
    mountpoint: string | null;
    targets: { container: string; path: string; mode: string }[];
    registryId: string | null;
    sizeLimit: number | null;
    copies: VolumeCopy[];
  }
  interface AppStorage {
    volumes: AppVolume[];
    otherMounts: { kind: 'bind' | 'tmpfs'; source: string | null; target: string; container: string }[];
    unreachable: string | null;
    manifestError: string | null;
  }

  let storage = $state<AppStorage | null>(null);
  let storageLoading = $state(false);
  let storageLoaded = $state(false);
  let storageError = $state<string | null>(null);
  /** Keyed by volume name, so two rows can never share a spinner. */
  let volumeBusy = $state<Record<string, string | null>>({});

  const ORIGIN_HINT: Record<AppVolume['origin'], string> = {
    registry: 'Declared in the volume registry and mounted by name.',
    'app-scoped': 'Created by Rudder for this application, and named after it.',
    shared:
      'The manifest names this volume outright, so it is not scoped to this application — ' +
      'another application naming it gets the same data. If one does, every operation here is ' +
      "refused: the storage is not this application's alone to back up, restore or delete.",
    foreign:
      'Rudder generated this name for a different application, so the data behind it is not ' +
      'this one\'s. It is mounted because the manifest asks for it, but it cannot be backed up, ' +
      'copied, restored or deleted from here — declaring another application\'s volume does not ' +
      'transfer it.',
  };

  /** The badge text. The origin values read as jargon on their own. */
  const ORIGIN_LABEL: Record<AppVolume['origin'], string> = {
    registry: 'registry',
    'app-scoped': 'this app',
    shared: 'shared',
    foreign: 'another app',
  };

  async function fetchStorage(force = false) {
    if (storageLoading) return;
    if (storageLoaded && !force) return;
    storageLoading = true;
    storageError = null;
    try {
      const res = await fetch(`/api/applications/${data.application.id}/volumes`);
      const body = await res.json();
      if (res.ok) {
        storage = body;
      } else {
        storageError = body.error || 'Could not load storage';
      }
    } catch (e: any) {
      storageError = e.message;
    } finally {
      storageLoading = false;
      storageLoaded = true;
    }
  }

  $effect(() => {
    if (activeTab === 'storage') fetchStorage();
  });

  /** How much of the volume's size figure we actually know. */
  function volumeSize(v: { sizeBytes: number | null; present?: boolean }): string {
    if (v.sizeBytes === null) return '—';
    return formatBytes(v.sizeBytes);
  }

  /**
   * Run one volume operation, and report what came back.
   *
   * `body` is the refused response's JSON, so a caller can act on what the server
   * said rather than assume: `deleteVolume` needs `canForce` to tell Podman's
   * "still in use" apart from the several other refusals that are also 409s.
   */
  async function volumeAction(
    name: string,
    label: string,
    url: string,
    method: string,
    body?: BodyInit,
  ): Promise<{ ok: boolean; body: any }> {
    volumeBusy[name] = label;
    try {
      const res = await fetch(url, { method, ...(body === undefined ? {} : { body }) });
      const result = await res.json();
      if (res.ok) {
        showToast('success', result.message || 'Done');
        await fetchStorage(true);
        return { ok: true, body: result };
      }
      // These refusals are paragraphs — which containers to stop, which other
      // application shares the volume — so they go in the detail modal rather
      // than a toast that truncates them.
      showDetail(`${label} failed`, [result.error || 'The request was refused.']);
      return { ok: false, body: result };
    } catch (e: any) {
      showDetail(`${label} failed`, [e.message]);
      return { ok: false, body: null };
    } finally {
      volumeBusy[name] = null;
    }
  }

  async function deleteVolume(v: AppVolume, isCopy: boolean) {
    const consequence = isCopy
      ? `The copy "${v.name}" and its contents are removed. The volume it was taken from is not touched.`
      : `Everything written to "${v.name}" is deleted from worker "${data.worker?.name ?? ''}". ` +
        `There is no undo, and no backup is taken. Take a copy or download a backup first if you ` +
        `might want the data.` +
        (v.declared
          ? ` The application still declares this volume, so the next deploy recreates it empty.`
          : '');
    const ok = await confirmAction({
      title: isCopy ? 'Delete this copy?' : `Delete "${v.label}" and its data?`,
      body: consequence,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    const url = `/api/applications/${data.application.id}/volumes/${encodeURIComponent(v.name)}`;
    const done = await volumeAction(v.name, 'Delete', url, 'DELETE');
    if (done.ok || isCopy) return;

    // Only when the server said forcing is the thing that would help. Every
    // refusal on this route is a 409 — a volume shared with another application,
    // one belonging to another application, an unreachable worker — and offering
    // the override for all of them stated Podman's reason for someone else's,
    // then invited a retry that is refused identically.
    if (!done.body?.canForce) return;

    // Podman refuses to remove a volume a container still mounts. Offering the
    // override separately keeps it an explicit second decision rather than
    // something the first click quietly did.
    const forced = await confirmAction({
      title: 'Force the delete?',
      body:
        `Podman refused because a container still mounts "${v.name}". Forcing removes the volume ` +
        `anyway; anything still reading or writing it will see its files vanish.`,
      confirmLabel: 'Force delete',
      danger: true,
    });
    if (!forced) return;
    await volumeAction(v.name, 'Force delete', `${url}?force=1`, 'DELETE');
  }

  async function copyVolume(v: AppVolume) {
    await volumeAction(
      v.name,
      'Copy',
      `/api/applications/${data.application.id}/volumes/${encodeURIComponent(v.name)}/copy`,
      'POST',
    );
  }

  async function restoreCopy(copy: VolumeCopy, onto: AppVolume) {
    const ok = await confirmAction({
      title: `Restore "${onto.label}" from this copy?`,
      body:
        `"${onto.name}" is emptied and replaced with the copy taken on ` +
        `${new Date(copy.at).toLocaleString()}. Anything written since then is lost. The ` +
        `application has to be stopped — the restore is refused otherwise.`,
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    const done = await volumeAction(
      copy.name,
      'Restore',
      `/api/applications/${data.application.id}/volumes/${encodeURIComponent(copy.name)}/copy`,
      'PUT',
    );
    if (done.ok) reloadWithFreshDrift(200);
  }

  // ── Restore from an uploaded archive ─────────────────────────────────────
  let showRestoreModal = $state(false);
  let restoreTarget = $state<AppVolume | null>(null);
  let restoreFile = $state<File | null>(null);
  let restoreMode = $state<'replace' | 'merge'>('replace');
  let restoreUploading = $state(false);

  function openRestore(v: AppVolume) {
    restoreTarget = v;
    restoreFile = null;
    restoreMode = 'replace';
    showRestoreModal = true;
  }

  async function submitRestore() {
    if (!restoreTarget || !restoreFile) return;
    const target = restoreTarget;
    const ok = await confirmAction({
      title: `Restore "${target.label}" from ${restoreFile.name}?`,
      body:
        restoreMode === 'replace'
          ? `"${target.name}" is emptied first, so the result is exactly what is in the archive. ` +
            `Everything currently in it is lost.`
          : `The archive is extracted over "${target.name}". Files it does not mention are left ` +
            `where they are, which can leave a mixture of old and new — for a database, a state ` +
            `that never existed.`,
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;

    restoreUploading = true;
    const done = await volumeAction(
      target.name,
      'Restore',
      `/api/applications/${data.application.id}/volumes/${encodeURIComponent(target.name)}` +
        `/restore?mode=${restoreMode}`,
      'POST',
      restoreFile,
    );
    restoreUploading = false;
    if (done.ok) {
      showRestoreModal = false;
      restoreTarget = null;
      reloadWithFreshDrift(200);
    }
  }

  // ── App-level actions ────────────────────────────────────────────────────
  //
  // Which controls to show is decided in lifecycle-controls.ts, so the rules
  // are unit-tested rather than only observable by finding an application in
  // the right state.
  const lifecycle = $derived(lifecycleControls(data.containers));

  async function stopApp() {
    const n = lifecycle.activeCount;
    const ok = await confirmAction({
      title: n > 1 ? `Stop all ${n} containers?` : 'Stop this application?',
      body: n > 1
        ? `Every container "${data.application.name}" is serving from stops until the application is started again. Containers retained from a previous deploy are not touched.`
        : `"${data.application.name}" stops serving traffic until it is started again.`,
      confirmLabel: n > 1 ? 'Stop all' : 'Stop',
      danger: true,
    });
    if (!ok) return;
    deployApp('stop');
  }

  async function restartApp() {
    const n = lifecycle.activeCount;
    if (lifecycle.confirmRestart) {
      const ok = await confirmAction({
        title: `Restart all ${n} containers?`,
        body: `Every service of "${data.application.name}" is interrupted at once. Nothing is pulled — each container restarts on the image it already has.`,
        confirmLabel: 'Restart all',
      });
      if (!ok) return;
    }
    deployApp('restart');
  }

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
        // A lifecycle action answers 200 even when some containers refused it —
        // something did happen — so the toast colour follows what came back and
        // not the status code. A green "Application stopped" over a stop that
        // stopped two of five is the one outcome worse than an error.
        showToast(body.failures?.length ? 'error' : 'success', body.message || 'Done');
        if (['deploy', 'start', 'stop', 'restart'].includes(action)) {
          reloadWithFreshDrift();
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

  async function containerAction(containerId: string, action: string, confirmRequest?: ConfirmRequest) {
    if (confirmRequest && !(await confirmAction(confirmRequest))) return;
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
        setTimeout(() => invalidateAll(), 600);
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
    const ok = await confirmAction({
      title: 'Pull the latest image and recreate this container?',
      body: 'The container is replaced, so it restarts. Traffic to it is interrupted while that happens.',
      confirmLabel: 'Pull and recreate',
    });
    if (!ok) return;
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
        setTimeout(() => invalidateAll(), 600);
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
        setTimeout(() => invalidateAll(), 800);
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
        setTimeout(() => invalidateAll(), 800);
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
        fetchHealth(c.id);
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

</script>

{#if detail}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="detail-backdrop" onclick={() => (detail = null)}></div>
  <div class="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
    <h2 id="detail-title">{detail.title}</h2>
    {#each detail.paragraphs as paragraph}
      <p class="detail-text">{paragraph}</p>
    {/each}
    <div class="detail-actions">
      <button class="btn-act" onclick={() => (detail = null)}>Close</button>
    </div>
  </div>
{/if}

<!-- ── Header ──────────────────────────────────────────────────────────── -->
<PageHeader
  title={data.application.name}
  back={{ href: '/applications', label: 'Back to Applications' }}
>
  {#snippet badge()}
    <span class="type-badge">{data.application.type}</span>
  {/snippet}

  {#snippet meta()}
    {#if data.application.type === 'compose' && data.serviceUrls && data.serviceUrls.length > 0}
      <div class="service-urls">
        {#each data.serviceUrls as svc}
          <a href={svc.url} target="_blank" rel="noopener" class="app-url">
            🌐 {svc.name}: {svc.url}
            <span class="ext-icon">↗</span>
          </a>
        {/each}
      </div>
    {:else if data.portUrls.length > 1}
      <!-- More than one published port. Each is its own line with the container
           port behind it and whether the login flow covers it, because on this
           application "the URL" is no longer a single answer. -->
      <div class="service-urls">
        {#each data.portUrls as route}
          <a href={route.url} target="_blank" rel="noopener" class="app-url">
            🌐 {route.url}
            {#if route.containerPort}<span class="port-hint">→ {route.containerPort}</span>{/if}
            <span class="auth-hint" class:protected={route.authenticated}>
              {route.authenticated ? 'OIDC' : 'no OIDC'}
            </span>
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
    {#if data.unroutedPorts.length > 0}
      <p class="unrouted-ports">
        Declared public but not routed:
        {#each data.unroutedPorts as entry, i}{i > 0 ? ', ' : ''}<strong>{entry.port}</strong>
          ({entry.reason}){/each}
      </p>
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
  {/snippet}

  {#snippet actions()}
    {#if data.worker && data.worker.status === 'online'}
      {@const hasContainers = data.containers.length > 0}
      <button class="btn-header {hasContainers ? 'btn-redeploy' : 'btn-success'}" onclick={() => deployApp('deploy')} disabled={deploying} title="Deploy or redeploy the application">
        {deploying ? 'Deploying…' : hasContainers ? '↻ Redeploy' : '▶ Deploy'}
      </button>
    {/if}
    <!-- Act on what is already on the worker, for the application as a whole.
         A compose file with five services needed five clicks and five reloads
         to be taken down; there was no control that meant "stop this
         application". Gated on the worker being reachable for the same reason
         Deploy is: all three are Podman calls. -->
    {#if data.worker?.status === 'online' && lifecycle.activeCount > 0}
      {#if lifecycle.canStart}
        <button class="btn-header btn-lifecycle-start" onclick={() => deployApp('start')} disabled={deploying} title="Start every container this application serves from">
          {lifecycleLabel('Start', lifecycle.activeCount)}
        </button>
      {/if}
      {#if lifecycle.canStopOrRestart}
        <button class="btn-header btn-lifecycle-stop" onclick={stopApp} disabled={deploying} title="Stop every container this application serves from">
          {lifecycleLabel('Stop', lifecycle.activeCount)}
        </button>
        <button class="btn-header btn-secondary" onclick={restartApp} disabled={deploying} title="Restart every container this application serves from, without pulling">
          {lifecycleLabel('Restart', lifecycle.activeCount)}
        </button>
      {/if}
      <span class="header-sep" aria-hidden="true"></span>
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
  {/snippet}
</PageHeader>

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

<!-- ── Drift ───────────────────────────────────────────────────────────────
     What is running disagrees with what should be. Shown above the tabs
     because it changes how everything below it should be read.

     Rendered even when there is nothing to report: the stored answer is up to
     one collection cycle old, so the moment you most want to re-run the
     comparison is exactly when the panel has nothing in it yet. Hiding the
     control until drift appeared put it out of reach at that moment. -->
{#if problems.length > 0}
  <div class="drift-panel">
    <div class="drift-head">
      <span class="drift-title">
        This application has drifted from its configuration
        <span class="drift-count">{problems.length}</span>
      </span>
      <div class="drift-actions">
        <button class="btn-act" onclick={recheckDrift} disabled={rechecking} title="Re-run the comparison now instead of waiting for the next collection cycle">
          {rechecking ? 'Checking…' : 'Re-check'}
        </button>
        {#if problems.some((d) => d.kind === 'missing' || d.kind === 'stale')}
          <!-- Named for what it does. It is not the reconciler — that one only
               ever reads — it is a full deploy, which on a control-plane-routed
               worker means a new generation alongside the old one. Calling it
               "Reconcile now" made the new container look like a malfunction. -->
          <button class="btn-act btn-start" onclick={reconcileNow} disabled={reconciling} title="Deploy the current configuration: creates what is missing, replaces what is out of date. On this worker that means starting a new version alongside the current one and switching traffic over once it is healthy.">
            {reconciling ? 'Deploying…' : 'Deploy current configuration'}
          </button>
        {/if}
      </div>
    </div>
    <ul class="drift-list">
      {#each problems as d}
        <li>
          <span class="drift-kind drift-{d.kind}">{DRIFT_LABEL[d.kind] ?? d.kind}</span>
          <code class="drift-name">{d.name}</code>
          <span class="drift-detail">{d.detail}</span>
        </li>
      {/each}
    </ul>
    <p class="drift-foot">
      Reconciliation only reports. Nothing here has been changed automatically.
    </p>
  </div>
{:else}
  <div class="drift-clean">
    <span class="drift-clean-text">
      {#if driftError}
        Drift could not be checked — {driftError}
      {:else}
        No drift reported. The stored comparison can be up to one collection cycle old.
      {/if}
    </span>
    <button class="btn-act" onclick={recheckDrift} disabled={rechecking} title="Re-run the comparison now instead of waiting for the next collection cycle">
      {rechecking ? 'Checking…' : 'Re-check'}
    </button>
  </div>
{/if}

<!-- Retained previous versions. Deliberately outside the panel above and styled
     down: this is the answer to "why are there two containers", which is a
     question asked most often when nothing is wrong. -->
{#if notices.length > 0}
  <ul class="drift-notice">
    {#each notices as d}
      <li>
        <span class="drift-kind drift-retained">{DRIFT_LABEL[d.kind]}</span>
        <code class="drift-name">{d.name}</code>
        <span class="drift-detail">{d.detail}</span>
      </li>
    {/each}
  </ul>
{/if}

<!-- ── Tabs ────────────────────────────────────────────────────────────── -->
<div class="tabs">
  {#each [['containers','Containers'],['metrics','Metrics'],['storage','Storage'],['firewall','Firewall'],['config','Configuration'],['deployments','Deployments']] as [id, label]}
    <button class:active={activeTab === id} onclick={() => activeTab = id}>{label}</button>
  {/each}
</div>

<div class="tab-content">
  <!-- ── Containers tab ─────────────────────────────────────────────────── -->
  {#if activeTab === 'containers'}
    {#if data.containers.length === 0}
      <div class="empty-row">
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
          <!-- A superseded generation. Traefik is not routing to it, so starting
               it produces a second running copy serving nothing, and updating it
               pulls an image for a version that is on its way out. Neither is
               ever what someone wants; both were one click away. -->
          {@const isSuperseded = container.state === 'draining'}
          <!-- The fleet sweep writes this when Podman has no container with the
               row's id. There is nothing to act on but the record itself. -->
          {@const isGhost = container.status === 'missing'}
          <div class="container-card">
            <div class="container-header">
              <div class="container-title">
                <h3>{container.name}</h3>
                <span class="status-badge {container.status}">{container.status}</span>
                <!-- Which generation this container belongs to, and whether it
                     is the one serving traffic. Both are visible at once during
                     a retention window, and telling them apart is the point. -->
                <span
                  class="generation-badge {container.state}"
                  title={container.state === 'active'
                    ? 'Serving traffic'
                    : container.state === 'pending'
                      ? 'Created by a deploy in progress; not routed'
                      : 'Superseded — no longer routed, kept so a rollback can restart it'}
                >g{container.generation} · {container.state}</span>
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
                {#if isGhost}
                  <!-- The container is gone; only the record is left. Removing it
                       is the whole of what can be done, and it is what releases
                       the host port the record is still reserving. -->
                  <button
                    class="btn-act btn-stop"
                    onclick={() => containerAction(container.id, 'remove', {
                      title: 'Clear this record?',
                      body: `No container with this id exists on the worker any more, so there is nothing to stop or start. Removing the record releases the host port it is still reserving.`,
                      confirmLabel: 'Clear record',
                      danger: true,
                    })}
                    disabled={busy}
                    title="Remove the database record for a container that no longer exists"
                  >Clear record</button>
                {:else if isSuperseded}
                  <!-- Reap, and nothing else. Start would run a version nothing
                       routes to; Update would pull for a version being retired. -->
                  <button
                    class="btn-act btn-stop"
                    onclick={() => containerAction(container.id, 'remove', {
                      title: 'Remove this previous version?',
                      body: `"${container.name}" is the superseded version, kept so a rollback could restart it. Removing it now frees its host port and gives up the fast rollback to this version — a rollback would have to redeploy instead.`,
                      confirmLabel: 'Remove',
                      danger: true,
                    })}
                    disabled={busy}
                    title="Remove this superseded version now instead of waiting for its retention window to pass"
                  >Reap</button>
                {:else}
                  {#if isRunning}
                    <button
                      class="btn-act btn-stop"
                      onclick={() => containerAction(container.id, 'stop', {
                        title: 'Stop this container?',
                        body: `"${container.name}" stops serving traffic until it is started again.`,
                        confirmLabel: 'Stop',
                        danger: true,
                      })}
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
                {/if}
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
      <div class="empty-row"><p>Deploy the application first to see metrics.</p></div>
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
      <div class="empty-row"><p class="loading-text">Loading deployment history...</p></div>
    {:else if deploymentsList.length === 0}
      <div class="empty-row"><p>No deployments recorded yet.</p></div>
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
              {@const isCurrent = dep.id === currentDeploymentId}
              {@const isBusy = rollbackBusy === dep.id}
              <tr class="deployment-row" class:latest={isCurrent}>
                <td class="version-cell">
                  <span class="version-number">v{dep.version}</span>
                  {#if isCurrent}
                    <span class="current-badge">current</span>
                  {:else if i === 0 && dep.status === 'failed'}
                    <span class="attempt-badge" title="This deploy did not take effect — the version marked current is still serving">
                      last attempt
                    </span>
                  {/if}
                </td>
                <td>
                  <span class="deploy-status-badge {dep.status}">{dep.status.replace('_', ' ')}</span>
                </td>
                <td class="mono image-cell" title={dep.imageDigest ? `${dep.image ?? ''}\n${dep.imageDigest}` : (dep.image ?? '')}>
                  {#if dep.image}
                    {dep.image.length > 40 ? dep.image.substring(0, 40) + '...' : dep.image}
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                  <!-- The tag is what the user recognises; the digest is what
                       ran, and is what a rollback restores. Both are shown
                       because a tag alone cannot answer "which bytes?". -->
                  {#if dep.imageDigest}
                    <span class="digest-line">{shortDigest(dep.imageDigest)}</span>
                  {:else}
                    <span class="digest-line muted">no digest recorded — rolls back by tag</span>
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
                  <!-- No rollback offered for the version already serving.
                       Keyed on current rather than newest, so after a failed
                       deploy the serving version stops offering to roll back
                       to itself. -->
                  {#if !isCurrent && dep.status === 'succeeded'}
                    <button
                      class="btn-act btn-rollback"
                      class:btn-rollback-fast={dep.fastRollback}
                      onclick={() => rollbackTo(dep)}
                      disabled={isBusy || rollbackBusy !== null}
                      title={dep.fastRollback
                        ? `These containers are still on the worker, stopped — rolling back restarts them`
                        : `Redeploy version ${dep.version} from its manifest`}
                    >
                      {isBusy ? 'Rolling back...' : dep.fastRollback ? 'Rollback (instant)' : 'Rollback'}
                    </button>
                  {/if}
                  {#if dep.errorMessage}
                    <button
                      class="btn-act btn-error-detail"
                      onclick={() => showDetail(`Version ${dep.version} failed`, [dep.errorMessage!])}
                      title="View error details"
                    >Error</button>
                  {/if}
                  {#if dep.notes?.length}
                    <button
                      class="btn-act btn-notes"
                      onclick={() => showDetail(`Notes on version ${dep.version}`, dep.notes!)}
                      title="This deploy succeeded, but not everything the manifest asked for was done as written"
                    >{dep.notes.length} note{dep.notes.length === 1 ? '' : 's'}</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  <!-- ── Storage tab ─────────────────────────────────────────────────────────
       Volumes for every deployment format, not just single-container ones.
       A compose file's `./data` is a real Podman volume that Rudder created and
       named; until now nothing in the UI could show it, size it or delete it. -->
  {:else if activeTab === 'storage'}
    {#if storageLoading && !storageLoaded}
      <div class="empty-row"><p class="loading-text">Reading volumes from the worker…</p></div>
    {:else if storageError}
      <div class="empty-row"><p class="error-text">{storageError}</p></div>
    {:else if storage}
      {#if storage.manifestError}
        <div class="storage-notice">
          <strong>This application's manifest no longer parses,</strong> so nothing is listed as
          declared. Anything found on the worker is still shown below — it still holds data.
          <span class="storage-notice-detail">{storage.manifestError}</span>
        </div>
      {/if}
      {#if storage.unreachable}
        <div class="storage-notice">{storage.unreachable}</div>
      {/if}

      <div class="storage-bar">
        <span class="storage-summary">
          {storage.volumes.length} volume{storage.volumes.length === 1 ? '' : 's'}
          {#if storage.volumes.some((v) => v.sizeBytes !== null)}
            · {formatBytes(storage.volumes.reduce((s, v) => s + (v.sizeBytes ?? 0), 0))} on disk
          {/if}
        </span>
        <button class="btn-act" onclick={() => fetchStorage(true)} disabled={storageLoading}
          title="Re-read the volume list and sizes from the worker">
          {storageLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {#if storage.volumes.length === 0}
        <div class="empty-row">
          <p>This application uses no named volumes.</p>
          {#if storage.otherMounts.length > 0}
            <p class="small">
              It does mount {storage.otherMounts.length} host path{storage.otherMounts.length === 1 ? '' : 's'}
              or scratch director{storage.otherMounts.length === 1 ? 'y' : 'ies'}, listed below.
            </p>
          {/if}
        </div>
      {:else}
        <div class="volumes-list">
          {#each storage.volumes as vol (vol.name)}
            {@const busy = volumeBusy[vol.name]}
            <div class="volume-card" class:volume-orphan={!vol.declared}>
              <div class="volume-head">
                <div class="volume-title">
                  <h3>{vol.label}</h3>
                  <span class="origin-badge origin-{vol.origin}" title={ORIGIN_HINT[vol.origin]}>
                    {ORIGIN_LABEL[vol.origin]}
                  </span>
                  {#if !vol.declared}
                    <span class="orphan-badge" title="Nothing in the current manifest mounts this volume. It is left over from a previous configuration and still holds data.">
                      not declared
                    </span>
                  {/if}
                  {#if !vol.present}
                    <span class="pending-badge" title="Declared by the manifest, but not on the worker yet. Podman creates a volume the first time a container mounts it.">
                      not created yet
                    </span>
                  {/if}
                </div>
                <!-- Nothing is offered on another application's volume: the
                     server refuses all four, so a row of buttons that can only
                     produce the same refusal is worse than the reason. -->
                <div class="volume-actions">
                  {#if vol.origin === 'foreign'}
                    <span class="text-muted">Owned by another application</span>
                  {:else}
                    {#if vol.present}
                      <!-- A plain link, not a fetch: the browser streams the tar
                           straight to disk instead of the page buffering it. -->
                      <a
                        class="btn-act"
                        href="/api/applications/{data.application.id}/volumes/{encodeURIComponent(vol.name)}/backup"
                        download
                        title="Download the whole volume as a tar archive"
                      >Backup</a>
                      <button class="btn-act" onclick={() => copyVolume(vol)} disabled={!!busy}
                        title="Copy the volume on the worker, as a safety net before a risky change">
                        {busy === 'Copy' ? 'Copying…' : 'Copy'}
                      </button>
                    {/if}
                    <button class="btn-act" onclick={() => openRestore(vol)} disabled={!!busy}
                      title="Upload a tar archive back into this volume">Restore…</button>
                    {#if vol.present}
                      <button class="btn-act btn-stop" onclick={() => deleteVolume(vol, false)} disabled={!!busy}
                        title="Delete the volume and everything written to it">
                        {busy?.includes('elete') ? 'Deleting…' : 'Delete'}
                      </button>
                    {/if}
                  {/if}
                </div>
              </div>

              <div class="volume-meta">
                <div class="meta-item">
                  <span class="meta-label">Size</span>
                  <span class="meta-value">
                    {volumeSize(vol)}
                    {#if vol.sizeLimit}
                      <span class="text-muted"> / {formatBytes(vol.sizeLimit)} intended</span>
                    {/if}
                  </span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Podman name</span>
                  <span class="meta-value mono">{vol.name}</span>
                </div>
                {#if vol.mountpoint}
                  <div class="meta-item">
                    <span class="meta-label">On the worker</span>
                    <span class="meta-value mono">{vol.mountpoint}</span>
                  </div>
                {/if}
              </div>

              {#if vol.targets.length > 0}
                <div class="mount-chips">
                  {#each vol.targets as t}
                    <span class="mount-chip" title="Mounted by {t.container} at {t.path} ({t.mode})">
                      <span class="chip-svc">{t.container}</span>
                      <span class="chip-path mono">{t.path}</span>
                      <span class="chip-mode">{t.mode}</span>
                    </span>
                  {/each}
                </div>
              {/if}

              {#if vol.copies.length > 0}
                <div class="copies">
                  <p class="copies-title">
                    {vol.copies.length} cop{vol.copies.length === 1 ? 'y' : 'ies'} on this worker
                  </p>
                  {#each vol.copies as copy (copy.name)}
                    {@const copyBusy = volumeBusy[copy.name]}
                    <div class="copy-row">
                      <span class="copy-when">{new Date(copy.at).toLocaleString()}</span>
                      <span class="copy-size">{volumeSize(copy)}</span>
                      <span class="copy-name mono">{copy.name}</span>
                      <span class="copy-actions">
                        <a
                          class="btn-act btn-xs"
                          href="/api/applications/{data.application.id}/volumes/{encodeURIComponent(copy.name)}/backup"
                          download
                          title="Download this copy as a tar archive"
                        >Backup</a>
                        <button class="btn-act btn-xs" onclick={() => restoreCopy(copy, vol)} disabled={!!copyBusy}
                          title="Replace the volume's contents with this copy">
                          {copyBusy === 'Restore' ? 'Restoring…' : 'Restore'}
                        </button>
                        <button class="btn-act btn-stop btn-xs" onclick={() => deleteVolume({ ...vol, name: copy.name, label: vol.label, copies: [] }, true)} disabled={!!copyBusy}
                          title="Delete this copy">Delete</button>
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Storage that is not a named volume. Listed so the tab does not read as
           "no storage" for an application that host-mounts everything. Neither
           can be sized, copied or deleted here: one is somebody else's
           directory, the other is memory. -->
      {#if storage.otherMounts.length > 0}
        <div class="other-mounts">
          <h4>Other mounts</h4>
          <table class="mini-table">
            <thead><tr><th>Type</th><th>Source</th><th>Mounted at</th><th>Container</th></tr></thead>
            <tbody>
              {#each storage.otherMounts as m}
                <tr>
                  <td>{m.kind === 'bind' ? 'host path' : 'tmpfs'}</td>
                  <td class="mono">{m.source ?? '—'}</td>
                  <td class="mono">{m.target}</td>
                  <td>{m.container}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="img-note">
            A host path belongs to the worker's filesystem and a tmpfs is memory that is gone when
            the container stops. Neither is backed up, copied or deleted from here.
          </p>
        </div>
      {/if}
    {/if}

  <!-- ── Firewall tab ───────────────────────────────────────────────────── -->
  {:else if activeTab === 'firewall'}
    <div class="section">
      <div class="section-head">
        <h3>Web firewall matches</h3>
        <!-- `btn-act`, not `btn-tiny`: this page has no `btn-tiny`, so that
             class rendered a raw browser button. -->
        <button class="btn-act" onclick={loadAppsec} disabled={appsecLoading}
          title="Re-read the firewall matches from the worker">
          {appsecLoading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      <p class="help-text">
        Every request to this application is inspected against the OWASP Core Rule Set. Rules do
        not block on their own — they add to a score, and an address that keeps crossing the
        threshold is <strong>banned from every application on the worker</strong>. So a rule
        matching your own legitimate traffic is not noise: it eventually locks that user out.
      </p>
      <p class="help-text">
        Grouped by the address the requests came from, and counted. <strong>The rule with the
        highest count against an address is the one to look at</strong> — check the paths it
        matched, and if that is traffic your application is supposed to serve, disable it here.
      </p>

      {#if appsec === null}
        <p class="empty">{appsecLoading ? 'Reading the firewall…' : 'Not loaded.'}</p>
      {:else if appsec.error}
        <p class="error">{appsec.error}</p>
      {:else}
        <AppsecMatches
          sources={appsec.sources}
          host={data.application.domain ?? undefined}
          canExclude={true}
          onExclude={excludeAppsecRule}
          busyRule={excludingRule}
          disabledRules={appsec.disabledRules ?? []}
        />
      {/if}

      {#if appsecMessage}
        <p class={appsecError ? 'error' : 'help-text'}>{appsecMessage}</p>
      {/if}

      {#if appsec && !appsec.error && appsec.sources.length > 0}
        <p class="help-text">
          Disabling a rule stops it protecting this application against everyone, on every port it
          serves. It takes effect within a minute. Rules shown as "cannot be disabled" are the
          anomaly-score threshold and CRS bookkeeping — the threshold is the only rule that
          enforces anything, so switching it off would disable the ruleset for this application
          rather than narrow it.
        </p>
      {/if}
    </div>

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
<Modal bind:open={showLimitsModal} title="Update Resource Limits">
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
</Modal>

<!-- ── Save as Template modal ──────────────────────────────────────── -->
<Modal bind:open={showTemplateModal} title="Save as Template">
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
</Modal>

<!-- ── Scale modal ────────────────────────────────────────────────── -->
<Modal bind:open={showScaleModal} title="Scale Application">
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
</Modal>

<!-- ── Restore-from-archive modal ─────────────────────────────────────────
     Separate from the confirmation dialog because it has to collect two things
     first — the archive and the mode — and the consequence depends on both. -->
<Modal
  bind:open={showRestoreModal}
  onclose={() => (restoreTarget = null)}
  maxWidth="560px"
  title="Restore a volume from an archive"
>
  {#if restoreTarget}
    <p class="help-text">
      Upload a tar archive produced by <strong>Backup</strong> on this volume. The application has
      to be stopped: the restore is refused while any of its containers are running, because
      writing over files a process has open can leave the data in a state that never existed.
    </p>
    <div class="form-group">
      <span class="restore-target-label">Restoring into</span>
      <code class="restore-target">{restoreTarget.name}</code>
    </div>
    <div class="form-group">
      <label for="restoreFile">Archive (.tar)</label>
      <input
        id="restoreFile"
        type="file"
        accept=".tar,application/x-tar"
        disabled={restoreUploading}
        onchange={(e) => (restoreFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
      />
      {#if restoreFile}
        <p class="field-hint">{restoreFile.name} — {formatBytes(restoreFile.size)}</p>
      {/if}
    </div>
    <div class="form-group">
      <span class="restore-target-label">How</span>
      <label class="radio-row">
        <input type="radio" value="replace" bind:group={restoreMode} disabled={restoreUploading} />
        <span>
          <strong>Replace</strong> — empty the volume first, so the result is exactly the archive.
        </span>
      </label>
      <label class="radio-row">
        <input type="radio" value="merge" bind:group={restoreMode} disabled={restoreUploading} />
        <span>
          <strong>Merge</strong> — extract over what is there. Files the archive does not mention
          stay put, which can mix old and new.
        </span>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick={() => (showRestoreModal = false)} disabled={restoreUploading}
        title="Close without restoring">Cancel</button>
      <button class="btn-primary" onclick={submitRestore} disabled={!restoreFile || restoreUploading}
        title="Upload the archive and restore the volume">
        {restoreUploading ? 'Restoring…' : 'Restore'}
      </button>
    </div>
  {/if}
</Modal>

<style>
  /* ── Detail modal — deploy errors and notes ────────────────────────── */
  .detail-backdrop { position: fixed; inset: 0; z-index: 2500; background: rgba(0,0,0,0.5); }
  .detail-modal {
    position: fixed; z-index: 2501;
    top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(620px, calc(100vw - 32px));
    max-height: min(70vh, 640px); overflow-y: auto;
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-md); padding: 20px 22px;
  }
  .detail-modal h2 { margin: 0 0 12px; font-size: 16px; color: var(--text-primary); }
  .detail-text {
    margin: 0 0 12px; font-size: 13px; line-height: 1.6; color: var(--text-secondary);
    white-space: pre-wrap; word-break: break-word;
  }
  .detail-actions { display: flex; justify-content: flex-end; }

  /* ── Header ────────────────────────────────────────────────────────── */
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
  .port-hint { font-size: 11px; opacity: 0.65; }
  /* Muted by default, tinted when the login flow covers the route: the eye
     should land on what *is* protected, not read a wall of identical chips. */
  .auth-hint {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: 8px;
    background: var(--bg-subtle);
    color: var(--text-muted);
  }
  .auth-hint.protected { background: var(--green-subtle); color: var(--green-text); }
  .unrouted-ports { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; max-width: 640px; }
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
  /* Written by the fleet sweep when Podman has no container with this row's id:
  a record without a container. Outlined rather than filled, because it is not
  describing the state of a container — there isn't one. */
  .status-badge.missing {
    background: transparent; color: var(--red-text);
    border: 1px dashed color-mix(in srgb, var(--red) 45%, transparent);
  }

  /* The muted base is what `draining` gets, and there is deliberately no
  override for it: that generation is not serving, and it should read as
  background rather than as a second live version of the application. */
  .generation-badge {
    padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.04em; background: var(--bg-raised); color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }
  .generation-badge.active { background: var(--accent-subtle); color: var(--accent); border-color: transparent; }
  .generation-badge.pending { background: var(--yellow-subtle); color: var(--yellow-text); border-color: transparent; }

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

  /* Application-level lifecycle. Deliberately the same green and yellow as the
  per-container Start and Stop above, so the header repeats a colour the
  container rows have already taught. Red stays reserved for Delete — a Stop
  that looked destructive would sit one misclick from the button that is. */
  .btn-header.btn-lifecycle-start {
    background: var(--green-subtle); color: var(--green-text);
    border: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
  }
  .btn-header.btn-lifecycle-start:hover:not(:disabled) { background: color-mix(in srgb, var(--green) 20%, transparent); }
  .btn-header.btn-lifecycle-stop {
    background: var(--yellow-subtle); color: var(--yellow-text);
    border: 1px solid color-mix(in srgb, var(--yellow) 30%, transparent);
  }
  .btn-header.btn-lifecycle-stop:hover:not(:disabled) { background: color-mix(in srgb, var(--yellow) 15%, transparent); }

  /* Separates "act on what is running" from "change or remove the
  application", which are otherwise nine buttons in one undifferentiated row. */
  .header-sep { width: 1px; align-self: stretch; background: var(--border-subtle); margin: 0 2px; }

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
  .help-text {
    margin-bottom: 16px;
  }

  /* ── Shared ────────────────────────────────────────────────────────── */
  .empty-row {
    background: var(--bg-overlay);
    border-radius: var(--radius-lg);
  }
  .empty-row p { margin-bottom: 16px; }
  .loading-text { color: var(--text-muted); font-style: italic; font-size: 13px; }
  .error-text { color: var(--red-text); font-size: 13px; }

  .empty { color: var(--text-muted); font-style: italic; text-align: center; padding: 30px; }
  .error { color: var(--red-text); font-size: 13px; }
  .template-error {
    background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red);
    border-radius: var(--radius-sm); padding: 8px 12px; font-size: 13px; margin-bottom: 12px;
  }

  /* ── Storage tab ──────────────────────────────────────────────────── */
  .storage-notice {
    background: var(--bg-overlay); border: 1px solid var(--border-default);
    border-left: 3px solid var(--yellow);
    border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 12px;
    font-size: 13px; color: var(--text-secondary); line-height: 1.5;
  }
  .storage-notice-detail {
    display: block; margin-top: 4px; font-family: var(--font-mono);
    font-size: 11px; color: var(--text-muted); word-break: break-word;
  }

  .storage-bar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 12px;
  }
  .storage-summary { font-size: 13px; color: var(--text-secondary); }

  .volumes-list { display: flex; flex-direction: column; gap: 12px; }
  .volume-card {
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg); padding: 16px 18px;
  }
  /* A volume nothing declares any more still holds data and still costs disk;
     dimmed rather than hidden, because it is the one most likely to be deleted. */
  .volume-card.volume-orphan { border-style: dashed; }

  .volume-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .volume-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .volume-title h3 {
    margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary);
    font-family: var(--font-mono);
  }
  .volume-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

  .origin-badge, .orphan-badge, .pending-badge {
    padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap;
  }
  .origin-registry { background: var(--accent-subtle); color: var(--accent); }
  .origin-app-scoped { background: var(--bg-overlay); color: var(--text-muted); }
  /* Not namespaced to this application, so deleting it may take another
     application's data with it. Coloured as the warning it is. */
  .origin-shared { background: var(--red-subtle); color: var(--red-text); }
  /* Somebody else's, provably. Same colour as `shared` — both are "not yours to
     act on" — and the badge text says which. */
  .origin-foreign { background: var(--red-subtle); color: var(--red-text); }
  .orphan-badge { background: var(--bg-overlay); color: var(--text-muted); }
  .pending-badge { background: var(--bg-overlay); color: var(--text-muted); }

  .volume-meta {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px; margin-top: 12px;
  }

  .mount-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .mount-chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--bg-overlay); border: 1px solid var(--border-subtle);
    border-radius: 12px; padding: 2px 10px; font-size: 11px;
  }
  .chip-svc { font-weight: 600; color: var(--text-secondary); }
  .chip-path { color: var(--text-muted); }
  .chip-mode { color: var(--text-muted); text-transform: uppercase; font-size: 9px; }

  .copies {
    margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-subtle);
  }
  .copies-title {
    margin: 0 0 8px; font-size: 10px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .copy-row {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 6px 0; font-size: 12px; color: var(--text-secondary);
  }
  .copy-when { min-width: 150px; }
  .copy-size { min-width: 70px; color: var(--text-muted); }
  .copy-name {
    flex: 1; min-width: 180px; color: var(--text-muted);
    font-size: 11px; word-break: break-all;
  }
  .copy-actions { display: flex; gap: 4px; }
  .btn-xs { font-size: 11px; padding: 2px 8px; }

  .other-mounts {
    margin-top: 20px; background: var(--bg-raised);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
    padding: 14px 18px;
  }
  .other-mounts h4 {
    margin: 0 0 10px; font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .other-mounts table { width: 100%; border-collapse: collapse; font-size: 12px; }

  /* ── Restore modal ─────────────────────────────────────────────────── */
  .restore-target-label {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px;
  }
  .restore-target {
    font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);
    background: var(--bg-overlay); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm); padding: 6px 10px; word-break: break-all;
  }
  .radio-row {
    display: flex; align-items: flex-start; gap: 8px; padding: 5px 0;
    font-size: 12px; color: var(--text-secondary); line-height: 1.45; cursor: pointer;
  }
  .radio-row input { margin-top: 2px; flex-shrink: 0; }
  .field-hint { margin: 6px 0 0; font-size: 12px; color: var(--text-muted); }

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
  /* The newest row when it failed: newest, but not what is serving. */
  .attempt-badge {
    padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 600;
    background: var(--bg-overlay); color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .image-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .digest-line {
    display: block;
    font-size: 10px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .digest-line.muted { color: var(--text-muted); font-style: italic; }

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
  /* Distinguished at a glance: a retained generation is a restart, everything
  else is a full redeploy, and the two are minutes apart. */
  .btn-rollback-fast {
    color: var(--green-text); border-color: color-mix(in srgb, var(--green) 35%, transparent);
    background: var(--green-subtle);
  }
  .btn-rollback-fast:hover:not(:disabled) { background: color-mix(in srgb, var(--green) 15%, transparent); }

  .btn-error-detail {
    color: var(--red-text); border-color: color-mix(in srgb, var(--red) 30%, transparent);
    background: var(--red-subtle); margin-left: 4px;
  }
  .btn-error-detail:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 15%, transparent); }

  /* Not a failure — the deploy worked, but not everything as written. */
  .btn-notes {
    color: var(--yellow-text); border-color: color-mix(in srgb, var(--yellow) 30%, transparent);
    background: var(--yellow-subtle); margin-left: 4px;
  }
  .btn-notes:hover:not(:disabled) { background: color-mix(in srgb, var(--yellow) 15%, transparent); }

  /* ── Drift ─────────────────────────────────────────────────────────────
  Amber rather than red: the application may well still be serving, and
  colouring a two-replica app with one dead replica the same as an outage
  teaches people to ignore the colour. */
  .drift-panel {
    border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent);
    background: var(--yellow-subtle);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 16px;
  }
  .drift-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .drift-title { color: var(--yellow-text); font-weight: 600; font-size: 0.9rem; }
  .drift-count {
    display: inline-block; min-width: 20px; text-align: center;
    background: color-mix(in srgb, var(--yellow) 25%, transparent);
    border-radius: 10px; padding: 1px 7px; margin-left: 6px;
    font-size: 0.78rem; font-variant-numeric: tabular-nums;
  }
  .drift-actions { display: flex; gap: 6px; }

  /* The clean state is a quiet one-liner, not a second amber banner — it is
  the normal condition and should not compete with anything on the page. */
  .drift-clean {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .drift-clean-text { color: var(--text-muted); font-size: 0.78rem; }
  .drift-list { list-style: none; margin: 10px 0 0; padding: 0; }
  .drift-list li {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    padding: 5px 0; font-size: 0.82rem;
    border-top: 1px solid color-mix(in srgb, var(--yellow) 18%, transparent);
  }
  .drift-kind {
    flex: 0 0 auto; font-size: 0.72rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.03em;
    padding: 2px 6px; border-radius: 4px;
    background: color-mix(in srgb, var(--yellow) 20%, transparent);
    color: var(--yellow-text);
  }
  /* Not running is the one state that means the application is down. */
  .drift-missing {
    background: color-mix(in srgb, var(--red) 18%, transparent);
    color: var(--red);
  }
  /* A retained version is correct, so it is grey wherever it appears — including
  inside the amber panel, where it can turn up after a re-check. */
  .drift-retained {
    background: var(--bg-subtle, color-mix(in srgb, var(--text-muted) 12%, transparent));
    color: var(--text-muted);
  }
  .drift-name { font-family: var(--font-mono, monospace); font-size: 0.78rem; }
  .drift-detail { color: var(--text-muted); flex: 1 1 220px; }
  .drift-foot { margin: 10px 0 0; font-size: 0.76rem; color: var(--text-muted); }

  /* Retained versions: a plain muted list, no banner. Says what the second
  container is without implying something needs doing about it. */
  .drift-notice { list-style: none; margin: -8px 0 16px; padding: 0; }
  .drift-notice li {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    padding: 4px 0; font-size: 0.78rem; color: var(--text-muted);
  }

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
