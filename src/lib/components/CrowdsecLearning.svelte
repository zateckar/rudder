<script lang="ts">
  import { onMount } from 'svelte';
  import type { LearningEnrollment, joinLearningAlerts } from '#lib/server/crowdsec-learning.ts';
  import type { compareLearningEvidence, LearningReview } from '#lib/crowdsec-learning-evidence.ts';

  let { applicationId }: { applicationId: string } = $props();
  const endpoint = $derived(`/api/applications/${applicationId}/appsec/learning`);
  let available = $state(false);
  let busy = $state(false);
  let message = $state('');
  let enrollment = $state<LearningEnrollment | null>(null);
  let activeSessionId = $state<string | null>(null);
  let observationInput = $state<HTMLInputElement>();
  let comparison = $state.raw<ReturnType<typeof compareLearningEvidence> | null>(null);
  let comparisonMessage = $state('');
  let comparisonRevision = 0;
  const outcomeLabels = { alerted: 'alert', blocked: 'inline block', banned: 'IP ban' };
  let session = $state<ReturnType<typeof joinLearningAlerts> | null>(null);
  const sessionEnded = $derived(session && (session.revokedAt !== null || Date.now() >= session.expiresAt));
  const status = $derived(!session ? 'Session available'
    : session.revokedAt !== null ? 'Revoked'
    : sessionEnded ? 'Expired'
    : session.enrolledAt !== null ? 'Enrolled'
    : 'Waiting for enrollment');
  const reviewedRequests = $derived((session?.requests ?? []).map((request) => ({
    requestId: request.id,
    rules: [...new Set(request.alerts.flatMap((alert) => alert.rules ?? []))].sort(),
    review: 'expected' satisfies LearningReview,
  })));
  const reviewExport = $derived(session && { schemaVersion: 1, sessionId: session.id, requests: reviewedRequests });
  const alerts = $derived([...new Map((session?.requests ?? [])
    .flatMap((request) => request.alerts.map((alert) => [alert.id, alert] as const))).values()]);

  function clearComparison() {
    comparisonRevision += 1;
    comparison = null;
    comparisonMessage = '';
  }

  async function importObservations(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const selectedReview = reviewExport;
    input.value = '';
    if (!file || !selectedReview) return;
    clearComparison();
    const revision = comparisonRevision;
    try {
      const { compareLearningEvidence: compare } = await import('#lib/crowdsec-learning-evidence.ts');
      const observations: unknown = JSON.parse(await file.text());
      if (revision === comparisonRevision) comparison = compare([selectedReview], observations);
    } catch {
      if (revision === comparisonRevision) comparisonMessage = 'Could not compare the observations with this review. Check the input format and request IDs.';
    }
  }

  function exportReview() {
    if (!reviewExport || !reviewedRequests.length) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(reviewExport, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `crowdsec-learning-${reviewExport.sessionId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  onMount(async () => {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const body = await response.json();
        available = body.available === true;
        activeSessionId = body.latest;
        if (available && activeSessionId) await manage('GET');
      }
    } catch {
      // The ordinary CrowdSec panel remains usable when the pilot is down.
    }
  });

  async function manage(method: 'POST' | 'GET' | 'DELETE') {
    busy = true;
    message = '';
    try {
      const url = method === 'POST' ? endpoint : `${endpoint}?id=${activeSessionId}`;
      const response = await fetch(url, { method });
      const body = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(body?.error ?? 'Could not read the learning session.');
      if (method === 'POST') {
        clearComparison();
        enrollment = body;
        activeSessionId = body.id;
        session = { id: body.id, expiresAt: body.expiresAt, enrolledAt: null, revokedAt: null, requests: [] };
      } else if (method === 'GET') {
        session = body;
        clearComparison();
      } else {
        if (session) session.revokedAt = Date.now();
        enrollment = null;
        if (!session) await manage('GET');
      }
    } catch (error) {
      message = error instanceof Error ? error.message : 'The learning request failed.';
    } finally {
      busy = false;
    }
  }
</script>

{#if available}
  <section class="section learning" aria-labelledby="learning-title">
    <div class="section-header learning-header">
      <div>
        <h2 id="learning-title">Learning session</h2>
        <p class="help-text">
          Enroll a browser to collect expected traffic and see matching CrowdSec alerts.
        </p>
      </div>
      <div class="learning-actions">
        {#if !activeSessionId || sessionEnded}
          <button class="btn-primary btn-sm" type="button" disabled={busy} onclick={() => manage('POST')}>
            Generate enrollment link
          </button>
        {/if}
        {#if activeSessionId}
          <button class="btn-secondary btn-sm" type="button" disabled={busy} onclick={() => manage('GET')}>Refresh</button>
          {#if !sessionEnded}
            <button class="btn-ghost" type="button" disabled={busy} onclick={() => manage('DELETE')}>Revoke enrollment</button>
          {/if}
        {/if}
      </div>
    </div>

    {#if activeSessionId}
      <div class="learning-summary" role="status">
        <span class="badge session-status" class:enrolled={status === 'Enrolled'}>{status}</span>
        {#if session}
          <span>{reviewedRequests.length} expected {reviewedRequests.length === 1 ? 'request' : 'requests'}</span>
          <span>{alerts.length} matching {alerts.length === 1 ? 'alert' : 'alerts'}</span>
        {/if}
      </div>
    {/if}

    {#if enrollment && status === 'Waiting for enrollment'}
      <div class="learning-block enrollment">
        <a class="btn-primary btn-sm" href={enrollment.link} target="_blank" rel="noreferrer">Open enrollment link</a>
        <p class="help-text">
          On another device, open <a href={enrollment.enrollmentPage} target="_blank" rel="noreferrer">{enrollment.enrollmentPage}</a>
          and enter <code>{enrollment.code}</code>.
        </p>
      </div>
    {/if}

    {#if message}<p class="error-msg learning-block" role="alert">{message}</p>{/if}

    {#if reviewedRequests.length}
      <div class="learning-block learning-actions">
        <button class="btn-secondary btn-sm" type="button" disabled={busy} onclick={exportReview}>Download session evidence</button>
        <button class="btn-secondary btn-sm" type="button" disabled={busy} onclick={() => observationInput?.click()}>
          Import paired observations
        </button>
        <input type="file" accept=".json,application/json" hidden bind:this={observationInput} onchange={importObservations} />
      </div>
    {/if}

    {#if alerts.length}
      <section class="learning-block">
        <h3>Matching alerts</h3>
        <ul class="learning-alerts">
          {#each alerts as alert (alert.id)}
            <li>
              <span>{alert.scenario}</span>
              <span class="help-text">Alert #{alert.id}{#if alert.rules?.length} · {alert.rules.join(', ')}{/if}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if comparisonMessage}<p class="error-msg learning-block" role="alert">{comparisonMessage}</p>{/if}
    {#if comparison}
      {@const improved = comparison.legitimate.filter((row) => row.matchedRule && row.improved.length).length}
      <section class="learning-block comparison" aria-label="CrowdSec proposal comparison">
        <h3>Proposed removal of <code>{comparison.change.ruleId}</code></h3>
        <p>{comparison.eligibleForReview ? 'Evidence supports operator review.' : 'Evidence does not support the proposal.'}</p>
        {#if improved}
          <p>Enforcement outcomes improved for {improved} expected {improved === 1 ? 'request' : 'requests'}.</p>
        {/if}
        <ul>
          {#each comparison.blockers as blocker (blocker)}<li>{blocker}</li>{/each}
          {#each comparison.operatorChecks as check (check)}<li>{check}</li>{/each}
        </ul>
        {#if comparison.probes.length}
          <ul>
            {#each comparison.probes as probe (probe.id)}
              <li>
                {probe.id} · {probe.lost.length ? `Lost ${probe.lost.map((outcome) => outcomeLabels[outcome]).join(', ')}` : 'Candidate outcomes retained'}
                {#if probe.baselineMissing.length} · Baseline missed {probe.baselineMissing.map((outcome) => outcomeLabels[outcome]).join(', ')}{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </section>
{/if}

<style>
  .learning-header,
  .learning-actions,
  .learning-summary,
  .enrollment {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }

  .learning-header { margin: 0; }
  .learning-header h2 { margin: 0; }
  .learning-summary, .learning-block { margin: 16px 0 0; }

  .learning-summary {
    padding: 10px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-overlay);
    color: var(--text-secondary);
    font-size: 13px;
  }

  .session-status { background: var(--bg-hover); color: var(--text-secondary); }
  .session-status.enrolled { background: var(--green-subtle); color: var(--green-text); }
  .enrollment .help-text { margin: 0; overflow-wrap: anywhere; }
  .enrollment code { color: var(--text-primary); font-weight: 600; }
  .learning-block h3 { margin: 0 0 8px; font-size: 14px; }

  .learning-alerts {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    overflow-wrap: anywhere;
  }

  .learning-alerts li { padding: 8px 12px; font-size: 13px; }
  .learning-alerts li + li { border-top: 1px solid var(--border-subtle); }

  .comparison {
    padding: 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .comparison p, .comparison ul { margin: 8px 0 0; }
  .comparison ul { padding-inline-start: 20px; }
</style>
