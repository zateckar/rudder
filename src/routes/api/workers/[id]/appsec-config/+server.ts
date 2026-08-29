import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { appsecExclusionsForWorker, generateAppsecConfig } from '$lib/server/appsec';
import { authenticateWorker } from '$lib/server/worker-token';
import { createHash } from 'crypto';

/**
 * GET /api/workers/[id]/appsec-config
 *
 * Machine-to-machine: the worker's `rudder-appsec-config` timer fetches this,
 * installs it where CrowdSec loads AppSec configurations, and restarts CrowdSec
 * when it changed. Credential is the per-worker token, as for the routing
 * endpoint.
 *
 * Served in **both** routing modes, unlike routing configuration. Which rules an
 * application is exempt from has nothing to do with whether Traefik learns its
 * routes from labels or from a file, and a labels-mode worker whose users are
 * being banned by a false positive needs this exactly as much.
 *
 * Excluded from the audit log along with the other polled endpoints: it is
 * fetched on a timer and would drown the trail.
 */
export const GET: RequestHandler = async ({ params, request, setHeaders }) => {
  setHeaders({ 'Cache-Control': 'no-store' });

  const worker = await authenticateWorker(params.id, request);
  if (!worker) return json({ error: 'Unauthorized' }, { status: 401 });

  let body: string;
  try {
    body = generateAppsecConfig(await appsecExclusionsForWorker(worker.id));
  } catch (e: any) {
    // Fail the fetch rather than serve a partial document. The worker keeps the
    // configuration it has, which is the last one that was complete — and
    // "keeps the old exclusions" is a far better failure than "installs a file
    // that removes rules nobody asked to remove", which is what a truncated
    // document could do.
    console.error('[appsec-config] generation failed for worker', worker.id, e?.message);
    return json({ error: 'Configuration unavailable' }, { status: 503 });
  }

  // The worker restarts CrowdSec whenever this document differs from the
  // installed one, so a body that varied between identical states would restart
  // the WAF on every poll. `appsecExclusionsForWorker` sorts for that reason;
  // the ETag is the second line of defence and lets an unchanged poll cost
  // nothing.
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'no-store' },
    });
  }

  return text(body, { headers: { 'Content-Type': 'text/yaml', ETag: etag } });
};
