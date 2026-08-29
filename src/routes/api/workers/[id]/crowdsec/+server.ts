import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';
import {
  decisionsFromExec,
  findCrowdsecContainer,
  groupAppsecBySource,
  parseAppsecAlerts,
  type AppsecSourceGroup,
  type DecisionsRead,
} from '$lib/server/crowdsec';

/**
 * Recent AppSec alerts, for the panel that names which rules actually fired.
 *
 * A decision cannot answer that question: the `rule_name` it carries is the
 * first id in the chain, which is usually a CRS initialisation rule that does
 * nothing when disabled. The alert's `rule_ids` is the real list, and it is only
 * on the alert.
 *
 * Best-effort — an empty list on any failure. The decisions above are the part
 * of this tab that must not lie about being complete; this is a convenience for
 * finding rule numbers, and a missing one costs an SSH session, not a bad
 * security decision.
 */
async function readAppsecAlerts(client: any, containerId: string): Promise<AppsecSourceGroup[]> {
  try {
    const { stdout, exitCode } = await client.execContainerHttp(
      containerId,
      ['cscli', 'alerts', 'list', '-a', '--limit', '200', '-o', 'json'],
      { attachStdout: true, attachStderr: true, tty: false },
    );
    return groupAppsecBySource(parseAppsecAlerts(stdout, exitCode) ?? []);
  } catch {
    return [];
  }
}

/**
 * Read the worker's active CrowdSec decisions.
 *
 * An `error` means the answer could not be obtained, which the caller must keep
 * distinct from an empty list. They look the same and mean opposite things.
 */
async function readDecisions(client: any, containerId: string): Promise<DecisionsRead> {
  try {
    const result = await client.execContainerHttp(
      containerId,
      ['cscli', 'decisions', 'list', '-o', 'json'],
      { attachStdout: true, attachStderr: true, tty: false },
    );
    return decisionsFromExec(result);
  } catch (err) {
    // The reason is the whole value here. This used to be a bare `catch {}`
    // returning null, so a worker that was unreachable, a CrowdSec that was
    // restarting and a TLS handshake that failed all reached the operator as
    // the same red sentence with nothing to go on.
    const message = err instanceof Error ? err.message : String(err);
    return { decisions: [], error: `Could not run cscli on this worker: ${message}` };
  }
}

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);
  const tailLines = parseInt(event.url.searchParams.get('tail') || '100');

  let crowdsecInspect: any = null;
  let crowdsecStatus = 'not_found';
  let crowdsecLogs = '';
  let decisions: DecisionsRead = {
    decisions: [],
    error: 'CrowdSec is not running on this worker, so no decisions could be read.',
  };
  let appsecAlerts: AppsecSourceGroup[] = [];

  if (worker.podmanApiUrl) {
    await withPodman(worker, async (client) => {
      try {
        const csC = await findCrowdsecContainer(client);
        if (!csC) return;

        crowdsecStatus = csC.State || 'unknown';
        try { crowdsecInspect = await client.getContainer(csC.Id); } catch {}
        try {
          crowdsecLogs = await client.getContainerLogs(csC.Id, {
            stdout: true,
            stderr: true,
            tail: tailLines,
          });
        } catch {}
        decisions = await readDecisions(client, csC.Id);
        appsecAlerts = await readAppsecAlerts(client, csC.Id);
      } catch (err) {
        // An unreachable worker leaves `not_found`, which is what the tab shows.
        const message = err instanceof Error ? err.message : String(err);
        decisions = { decisions: [], error: `Could not reach the worker: ${message}` };
      }
    });
  }

  // Only the two fields the tab renders. The full `podman inspect` carries
  // Config.Env, which holds BOUNCER_KEY_traefik in plaintext — sending it to
  // the browser puts a live credential in DevTools and in any exported HAR.
  // The bouncer key itself is likewise never returned: whether one is
  // configured is all the page needs to say.
  //
  // `decisions` used to be hardcoded to `[]`, on the reasoning that the LAPI is
  // unreachable from the control plane. The page rendered that as "No active
  // decisions — all clear", so a worker with three live bans — including one on
  // the operator reading the page — reported itself clear. An empty list and no
  // answer are different facts, and `decisionsAvailable` is what keeps them
  // apart here instead of collapsing both into a reassurance.
  //
  // `decisionsError` carries *which* failure it was. Without it the tab could
  // only say "could not read decisions", which is not enough to act on when it
  // happens on one refresh in ten.
  return json({
    status: crowdsecStatus,
    image: crowdsecInspect?.Config?.Image ?? null,
    startedAt: crowdsecInspect?.State?.StartedAt ?? null,
    logs: crowdsecLogs,
    bouncerKeyConfigured: !!worker.crowdsecBouncerKey,
    decisions: decisions.decisions,
    decisionsAvailable: decisions.error === null,
    decisionsError: decisions.error,
    appsecAlerts,
    appsecStatus: '',
  });
});

/**
 * Lift one decision — the WAF equivalent of unbanning an address.
 *
 * Admin-only through `requireWorker`, and audited by the hook that classifies
 * every mutating `/api/` request, because this removes a security control on a
 * production host and "who lifted that ban" is the question afterwards.
 */
export const DELETE: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const raw = event.url.searchParams.get('decision') ?? '';
  // Numeric ids only. `execContainerHttp` takes an argv array, so there is no
  // shell to inject into — but an id is a number, and refusing anything else
  // means a malformed one is a 400 here rather than a confusing `cscli` error.
  if (!/^\d+$/.test(raw)) {
    return json({ error: 'A numeric decision id is required.' }, { status: 400 });
  }

  if (!worker.podmanApiUrl) {
    return json({ error: 'Worker has no Podman API configured.' }, { status: 409 });
  }

  let result: { ok: boolean; message: string } = {
    ok: false,
    message: 'CrowdSec is not running on this worker.',
  };

  await withPodman(worker, async (client) => {
    const csC = await findCrowdsecContainer(client);
    if (!csC) return;

    const { stdout, stderr, exitCode, exitCodeKnown } = await client.execContainerHttp(
      csC.Id,
      ['cscli', 'decisions', 'delete', '--id', raw],
      { attachStdout: true, attachStderr: true, tty: false },
    );

    // An unread exit code reports 0, which for a *read* is worth trusting
    // alongside the output. Here it is not: claiming a ban was lifted when the
    // worker never confirmed it sends someone away believing they have access
    // they may not have. Say what is actually known and let them re-check.
    if (!exitCodeKnown) {
      result = {
        ok: false,
        message:
          'Rudder could not confirm the outcome on the worker. Refresh the decisions ' +
          'list to see whether the ban was lifted.',
      };
      return;
    }

    result = {
      ok: exitCode === 0,
      // `cscli` reports the outcome on stdout and problems on stderr; whichever
      // spoke is what the operator needs to see, verbatim.
      message: (stdout.trim() || stderr.trim() || '').slice(0, 500),
    };
  });

  return json(result, { status: result.ok ? 200 : 502 });
});
