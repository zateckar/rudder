<script lang="ts">
  import { onMount } from 'svelte';
  import type { LearningAlert, LearningEnrollment } from '$lib/server/crowdsec-learning';

  let { applicationId }: { applicationId: string } = $props();
  const endpoint = $derived(`/api/applications/${applicationId}/appsec/learning`);
  let available = $state(false);
  let busy = $state(false);
  let message = $state('');
  let enrollment = $state<LearningEnrollment | null>(null);
  let activeSessionId = $state<string | null>(null);
  let session = $state<{
    enrolledAt: number | null;
    revokedAt: number | null;
    expiresAt: number;
    alertsTruncated: boolean;
    requests: { id: string; status: number; alerts: LearningAlert[] }[];
  } | null>(null);

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
        enrollment = body;
        activeSessionId = body.id;
      } else if (method === 'GET') {
        session = body;
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
        {#if session.alertsTruncated}<p>Only the latest 1,000 stored alerts were checked.</p>{/if}
        <ul>
          {#each session.requests as request (request.id)}
            <li>
              HTTP {request.status} · <code>{request.id}</code>
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
