<script lang="ts">
  import { formatBytes } from '$lib/format';
  import { showToast } from '$lib/client/toast.svelte';
  import {
    composeMounts,
    composeServiceNames,
    k8sVolumeSnippet,
    useVolumeInCompose,
  } from '$lib/manifest-volumes';

  /**
   * Existing volumes the team already has on the chosen worker, offered while a
   * compose file or Kubernetes manifest is being written.
   *
   * A template's `./models` becomes a new, empty volume for every application
   * created from it — so the second model server on a worker downloads forty
   * gigabytes the first one already has. This puts the volumes that exist in
   * front of the person writing the manifest, and wires one in with a click.
   */
  interface Candidate {
    name: string;
    apps: string[];
    paths: string[];
    sizeBytes: number | null;
    present: boolean;
    mountable: boolean;
    reason: string | null;
  }

  let {
    workerId,
    teamId,
    appType,
    manifest = $bindable(),
  }: { workerId: string; teamId: string; appType: 'compose' | 'k8s'; manifest: string } = $props();

  let candidates = $state<Candidate[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let unreachable = $state<string | null>(null);
  let showUnmountable = $state(false);
  /** Where each candidate goes, keyed by volume name. */
  let choice = $state<Record<string, { service: string; path: string; readOnly: boolean }>>({});
  let snippetFor = $state<string | null>(null);

  const services = $derived(appType === 'compose' ? composeServiceNames(manifest) : []);
  const mounts = $derived(appType === 'compose' ? composeMounts(manifest) : []);
  const mountable = $derived(candidates.filter((c) => c.mountable));
  const unmountable = $derived(candidates.filter((c) => !c.mountable));

  /** Asked again whenever the team or the worker changes; a stale answer is dropped. */
  let request = 0;
  $effect(() => {
    const w = workerId;
    const t = teamId;
    if (!w || !t) {
      candidates = [];
      return;
    }
    load(w, t);
  });

  async function load(w: string, t: string) {
    const mine = ++request;
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/volumes/candidates?workerId=${encodeURIComponent(w)}&teamId=${encodeURIComponent(t)}`);
      const body = await res.json();
      if (mine !== request) return;
      if (!res.ok) {
        error = body.error || 'Could not list existing volumes';
        candidates = [];
        return;
      }
      candidates = body.candidates ?? [];
      unreachable = body.unreachable ?? null;
      for (const c of candidates) {
        choice[c.name] ??= { service: serviceFor(c), path: c.paths[0] ?? '/data', readOnly: false };
      }
    } catch (e: any) {
      if (mine === request) error = e.message;
    } finally {
      if (mine === request) loading = false;
    }
  }

  /** A mount in the manifest at a path this volume is used at elsewhere. */
  function matchFor(c: Candidate) {
    return mounts.find((m) => c.paths.includes(m.target) && m.source !== c.name) ?? null;
  }

  function inManifest(c: Candidate): boolean {
    return appType === 'compose'
      ? mounts.some((m) => m.source === c.name)
      : new RegExp(`claimName:\\s*["']?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm').test(manifest);
  }

  /** The service a candidate goes into: picked, or the one it would replace a mount in, or the first. */
  function serviceFor(c: Candidate): string {
    const picked = choice[c.name]?.service;
    if (picked && services.includes(picked)) return picked;
    return matchFor(c)?.service ?? services[0] ?? '';
  }

  function composeSnippet(c: Candidate): string {
    const { path, readOnly } = choice[c.name];
    return [
      'services:',
      `  ${serviceFor(c) || '<service>'}:`,
      '    volumes:',
      `      - ${c.name}:${path}${readOnly ? ':ro' : ''}`,
      '',
      'volumes:',
      `  ${c.name}:`,
      '    external: true',
    ].join('\n');
  }

  function snippet(c: Candidate): string {
    const { path, readOnly } = choice[c.name];
    return appType === 'compose' ? composeSnippet(c) : k8sVolumeSnippet(c.name, path, readOnly);
  }

  function use(c: Candidate) {
    const { path, readOnly } = choice[c.name];
    if (!path.startsWith('/')) {
      showToast('error', 'The mount path must be an absolute path inside the container, such as /data.');
      return;
    }
    if (appType === 'k8s') {
      snippetFor = snippetFor === c.name ? null : c.name;
      return;
    }
    const service = serviceFor(c);
    const edited = service ? useVolumeInCompose(manifest, service, c.name, path, readOnly) : null;
    if (edited === null) {
      snippetFor = c.name;
      showToast('error', 'Could not edit this manifest automatically — add the lines shown below by hand.');
      return;
    }
    manifest = edited;
    snippetFor = null;
    showToast('success', `Mounted "${c.name}" at ${path} in ${service}.`);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', 'Copied');
    } catch {
      showToast('error', 'Could not copy — select the text instead.');
    }
  }
</script>

{#if workerId && teamId && (loading || candidates.length > 0 || error)}
  <div class="form-section">
    <h2>Existing Volumes</h2>
    <p class="help-text">
      Volumes your team's applications already have on this worker. Mount one instead of starting
      empty — a model cache, a dataset — and both applications read and write the same data, live.
      {#if appType === 'k8s'}
        A Kubernetes manifest mounts one through a <code>persistentVolumeClaim</code> whose
        <code>claimName</code> is the volume's name.
      {/if}
    </p>

    {#if loading && candidates.length === 0}
      <p class="empty-hint">Looking for volumes…</p>
    {:else if error}
      <p class="empty-hint">{error}</p>
    {:else}
      {#if unreachable}<p class="empty-hint">{unreachable}</p>{/if}

      {#each mountable as c (c.name)}
        {@const match = matchFor(c)}
        {@const used = inManifest(c)}
        <div class="candidate">
          <div class="candidate-head">
            <code class="vol-name">{c.name}</code>
            <span class="meta">
              {c.sizeBytes != null ? formatBytes(c.sizeBytes) : c.present ? '' : 'not created yet'}
              · used by {c.apps.join(', ')}{c.paths.length ? ` at ${c.paths.join(', ')}` : ''}
            </span>
            {#if used}<span class="badge">in this manifest</span>{/if}
          </div>
          {#if match && !used}
            <p class="match">
              Fits <code>{match.source}:{match.target}</code> in <strong>{match.service}</strong> — using it
              replaces that mount.
            </p>
          {/if}
          {#if !used}
            <div class="candidate-controls">
              {#if appType === 'compose'}
                <select bind:value={choice[c.name].service} aria-label="Service">
                  {#each services as s}
                    <option value={s}>{s}</option>
                  {/each}
                </select>
              {/if}
              <input type="text" bind:value={choice[c.name].path} placeholder="/data" aria-label="Mount path" />
              <label class="ro"><input type="checkbox" bind:checked={choice[c.name].readOnly} /> read-only</label>
              <button type="button" class="btn-add" onclick={() => use(c)}>
                {appType === 'compose' ? 'Use' : snippetFor === c.name ? 'Hide' : 'Show YAML'}
              </button>
            </div>
          {/if}
          {#if snippetFor === c.name}
            <div class="snippet">
              <pre>{snippet(c)}</pre>
              <button type="button" class="btn-add" onclick={() => copy(snippet(c))}>Copy</button>
            </div>
          {/if}
        </div>
      {:else}
        <p class="empty-hint">
          None of your team's volumes on this worker can be mounted by another application.
        </p>
      {/each}

      {#if unmountable.length > 0}
        <button type="button" class="link-btn" onclick={() => (showUnmountable = !showUnmountable)}>
          {showUnmountable ? 'Hide' : 'Show'} {unmountable.length} volume{unmountable.length === 1 ? '' : 's'} a new application cannot mount
        </button>
        {#if showUnmountable}
          {#each unmountable as c (c.name)}
            <div class="candidate muted">
              <div class="candidate-head">
                <code class="vol-name">{c.name}</code>
                <span class="meta">
                  {c.sizeBytes != null ? formatBytes(c.sizeBytes) : ''} · {c.apps.join(', ')}{c.paths.length ? ` at ${c.paths.join(', ')}` : ''}
                </span>
              </div>
              <p class="match">{c.reason}</p>
            </div>
          {/each}
        {/if}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .candidate {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .candidate.muted { opacity: 0.7; }
  .candidate-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .vol-name { font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); }
  .meta { font-size: 12px; color: var(--text-muted); }
  .badge {
    font-size: 11px; padding: 1px 6px; border-radius: var(--radius-sm);
    color: var(--green-text); border: 1px solid var(--green);
  }
  .match { font-size: 12px; color: var(--text-secondary); margin: 6px 0 0; }
  .candidate-controls { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .candidate-controls select { width: auto; min-width: 120px; }
  .candidate-controls input[type='text'] { width: 200px; }
  .ro { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); margin: 0; }
  .snippet { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; }
  .snippet pre {
    flex: 1; margin: 0; padding: 8px 10px; font-size: 12px; font-family: var(--font-mono);
    background: var(--bg-overlay); border-radius: var(--radius-sm); overflow-x: auto;
  }
  .link-btn {
    background: none; border: none; padding: 0; margin-top: 4px; cursor: pointer;
    color: var(--accent); font-size: 12px; text-decoration: underline;
  }
</style>
