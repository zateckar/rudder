<script lang="ts">
  import { onMount } from 'svelte';
  import type { LearningAlert, LearningEnrollment } from '#lib/server/crowdsec-learning.ts';
  import type { compareLearningEvidence, LearningReview } from '#lib/crowdsec-learning-evidence.ts';

  let { applicationId }: { applicationId: string } = $props();
  const endpoint = $derived(`/api/applications/${applicationId}/appsec/learning`);
  let available = $state(false);
  let busy = $state(false);
  let message = $state('');
  let enrollment = $state<LearningEnrollment | null>(null);
  let activeSessionId = $state<string | null>(null);
  let reviews = $state<Record<string, LearningReview | undefined>>({});
  let comparison = $state.raw<ReturnType<typeof compareLearningEvidence> | null>(null);
  let comparisonMessage = $state('');
  let comparisonRevision = 0;
  const outcomeLabels = { alerted: 'alert', blocked: 'inline block', banned: 'IP ban' };
  let session = $state<{
    id: string;
    enrolledAt: number | null;
    revokedAt: number | null;
    expiresAt: number;
    requests: { id: string; at: number; status: number | null; alerts: LearningAlert[] }[];
  } | null>(null);
  const reviewedRequests = $derived((session?.requests ?? []).flatMap((request) => {
    const review = reviews[request.id];
    if (!review) return [];
    return [{
      requestId: request.id,
      rules: [...new Set(request.alerts.flatMap((alert) => alert.rules ?? []))].sort(),
      review,
    }];
  }));
  const reviewExport = $derived(session && { schemaVersion: 1, sessionId: session.id, requests: reviewedRequests });

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
        session = null;
        reviews = {};
        clearComparison();
        enrollment = body;
        activeSessionId = body.id;
      } else if (method === 'GET') {
        session = body;
        clearComparison();
      } else {
        if (session) session.revokedAt = Date.now();
        enrollment = null;
        message = 'Enrollment revoked.';
      }
    } catch (error) {
      message = error instanceof Error ? error.message : 'The learning request failed.';
    } finally {
      busy = false;
    }
  }
</script>

{#if available}
  <section aria-label="CrowdSec learning">
    <h3>Learning session</h3>
    <p>Capture requests to this application and review their matching alerts. CrowdSec applies its usual decisions.</p>
    <button type="button" disabled={busy} onclick={() => manage('POST')}>Generate enrollment link</button>
    {#if enrollment}
      <p><a href={enrollment.link} target="_blank" rel="noreferrer">Open enrollment link</a></p>
      <p>On another device, open <code>{enrollment.enrollmentPage}</code> and enter <code>{enrollment.code}</code>.</p>
    {/if}
    {#if activeSessionId}
      <button type="button" disabled={busy} onclick={() => manage('GET')}>Refresh captured requests</button>
      <button type="button" disabled={busy} onclick={() => manage('DELETE')}>Revoke enrollment</button>
      {#if session}
        <p>
          {session.revokedAt ? 'Revoked' : Date.now() >= session.expiresAt ? 'Expired' : session.enrolledAt ? 'Enrolled' : 'Waiting for enrollment'}
          · {session.requests.length} captured requests
        </p>
        {#if session.requests.length}
          <p>Review the requests you recognize. Download the review before leaving this page.</p>
          <button type="button" disabled={!reviewedRequests.length} onclick={exportReview}>Download reviewed requests</button>
          <label>
            Import paired observations
            <input type="file" accept=".json,application/json" disabled={!reviewedRequests.length} onchange={importObservations} />
          </label>
        {/if}
        {#if comparisonMessage}<p role="status">{comparisonMessage}</p>{/if}
        {#if comparison}
          <section aria-label="CrowdSec proposal comparison">
            <h4>Proposed removal of <code>{comparison.change.ruleId}</code></h4>
            <p>{comparison.eligibleForReview ? 'Evidence supports operator review.' : 'Evidence does not support the proposal.'}</p>
            <ul>
              {#each comparison.blockers as blocker (blocker)}<li>{blocker}</li>{/each}
              {#each comparison.operatorChecks as check (check)}<li>{check}</li>{/each}
            </ul>
            <ul>
              {#each comparison.legitimate.filter((row) => row.matchedRule && row.improved.length) as row (row.requestId)}
                <li><code>{row.requestId}</code> · Removed {row.improved.map((outcome) => outcomeLabels[outcome]).join(', ')}</li>
              {/each}
              {#each comparison.probes as probe (probe.id)}
                <li>
                  {probe.id} · {probe.lost.length ? `Lost ${probe.lost.map((outcome) => outcomeLabels[outcome]).join(', ')}` : 'Candidate outcomes retained'}
                  {#if probe.baselineMissing.length} · Baseline missed {probe.baselineMissing.map((outcome) => outcomeLabels[outcome]).join(', ')}{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <ul>
          {#each session.requests as request (request.id)}
            <li>
              <time datetime={new Date(request.at).toISOString()}>{new Date(request.at).toLocaleTimeString()}</time>
              · {request.status === null ? 'Captured' : `HTTP ${request.status}`} · <code>{request.id}</code>
              <label>
                Request review
                <select bind:value={reviews[request.id]} onchange={clearComparison}>
                  <option value={undefined}>Unreviewed</option>
                  <option value="expected">Expected</option>
                  <option value="unexpected">Unexpected</option>
                  <option value="uncertain">Uncertain</option>
                </select>
              </label>
              {#if request.alerts.length}
                <ul>
                  {#each request.alerts as alert (alert.id)}
                    <li>
                      Alert {alert.id} · {alert.scenario}
                      {#if alert.rules?.length}<small> ({alert.rules.join(', ')})</small>{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
  </section>
{/if}
