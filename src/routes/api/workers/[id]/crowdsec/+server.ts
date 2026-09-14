import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';
import {
  crowdsecReadError,
  decisionsFromExec,
  groupAppsecBySource,
  isRestartSymptom,
  openCrowdsec,
  parseAppsecAlerts,
  type AppsecSourceGroup,
  type CscliResult,
  type DecisionsRead,
} from '$lib/server/crowdsec';
import {
  decisionsLifted,
  exemptionCommands,
  exemptionRefusal,
  exemptionsFromExec,
  listAlreadyExists,
  normaliseComment,
  type ExemptionsRead,
} from '$lib/server/crowdsec-exemptions';

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
async function readAppsecAlerts(
  exec: (cmd: string[]) => Promise<CscliResult>,
): Promise<AppsecSourceGroup[]> {
  try {
    const { stdout, exitCode } = await exec([
      'cscli', 'alerts', 'list', '-a', '--limit', '200', '-o', 'json',
    ]);
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
async function readDecisions(
  exec: (cmd: string[]) => Promise<CscliResult>,
): Promise<DecisionsRead & { restarting: boolean }> {
  try {
    return {
      ...decisionsFromExec(await exec(['cscli', 'decisions', 'list', '-o', 'json'])),
      restarting: false,
    };
  } catch (err) {
    // The reason is the whole value here. This used to be a bare `catch {}`
    // returning null, so a worker that was unreachable, a CrowdSec that was
    // restarting and a TLS handshake that failed all reached the operator as
    // the same red sentence with nothing to go on. A restarting CrowdSec is
    // named as such rather than passed through as Podman's `container state
    // improper`, which is true and tells nobody what to do about it.
    //
    // `restarting` is read from the error itself and not from the sentence:
    // `crowdsecReadError` has already turned Podman's words into the operator's,
    // and pattern-matching the result would be reading our own prose back.
    return { decisions: [], error: crowdsecReadError(err), restarting: isRestartSymptom(err) };
  }
}

/**
 * The worker's CrowdSec exemptions.
 *
 * Read like the decisions and not like the AppSec alerts — an `error` rather
 * than a quiet empty list. The two are opposite facts here in a way that
 * matters: "nothing is exempt" is a statement about the worker's security
 * posture, and one produced by a failed read would send someone to add an
 * exemption that already exists, or to conclude a caller is still exposed when
 * it is not.
 */
async function readExemptions(
  exec: (cmd: string[]) => Promise<CscliResult>,
): Promise<ExemptionsRead> {
  try {
    return exemptionsFromExec(await exec(exemptionCommands.read()));
  } catch (err) {
    return { exemptions: [], error: crowdsecReadError(err) };
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
  let exemptions: ExemptionsRead = {
    exemptions: [],
    error: 'CrowdSec is not running on this worker, so no exemptions could be read.',
  };
  /** Set when the only thing wrong is that CrowdSec is coming back up. */
  let restarting = false;

  if (worker.podmanApiUrl) {
    await withPodman(worker, async (client) => {
      try {
        // Opened before the status is read, and that order is deliberate: the
        // session waits out a restart, so what this tab reports afterwards is
        // the container that came back rather than the corpse of the one that
        // went away. Excluding a rule restarts CrowdSec, so an admin lands here
        // mid-restart by using the feature as intended.
        const session = await openCrowdsec(client);
        const csC = session.container;
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

        // Logs are readable on a stopped container and are the most useful thing
        // on the tab when CrowdSec has just gone down, so they are fetched
        // first and unconditionally. `cscli` is not: exec needs it running, and
        // asking anyway returns Podman's `container state improper` in place of
        // the fact that it is restarting.
        if (session.error) {
          decisions = { decisions: [], error: session.error };
          exemptions = { exemptions: [], error: session.error };
          restarting = session.restarting;
          return;
        }

        const read = await readDecisions(session.exec);
        decisions = read;
        restarting = read.restarting;
        appsecAlerts = await readAppsecAlerts(session.exec);
        exemptions = await readExemptions(session.exec);
      } catch (err) {
        // An unreachable worker leaves `not_found`, which is what the tab shows.
        const message = err instanceof Error ? err.message : String(err);
        decisions = { decisions: [], error: `Could not reach the worker: ${message}` };
        exemptions = { exemptions: [], error: `Could not reach the worker: ${message}` };
        restarting = isRestartSymptom(err);
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
    // Whether the read failed because CrowdSec is coming back up — which is what
    // excluding a rule does to it. The tab reloads itself on this instead of
    // reporting a fault the admin caused on purpose and cannot act on.
    restarting,
    appsecAlerts,
    appsecStatus: '',
    // Same three-field shape as the decisions above, and for the same reason:
    // an empty list and an unanswered question must not both render as "nothing
    // is exempt here".
    exemptions: exemptions.exemptions,
    exemptionsAvailable: exemptions.error === null,
    exemptionsError: exemptions.error,
  });
});

/**
 * Exempt an address from every CrowdSec decision on this worker.
 *
 * The blunter of the two controls on this tab, and the only one that works
 * against the scenarios that cause most bans. A rule exclusion answers "this CRS
 * rule misfires on my application"; nothing answers `http-probing` or
 * `http-generic-403-bf`, which read Traefik's access log, name no rule and
 * attribute to no Host. Worse, `http-generic-403-bf` is self-sustaining: the ban
 * makes every request 403, and those 403s are what it counts. On a live worker
 * one address held 32 simultaneous decisions from it, regenerating faster than
 * they could be lifted.
 *
 * Admin-only through `requireWorker`, and audited by the hook that classifies
 * every mutating `/api/` request — this exempts an address from a security
 * control on a production host, for every application on it.
 */
export const POST: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const body = await event.request.json().catch(() => ({}) as any);
  const value = String(body?.value ?? '').trim();
  const comment = normaliseComment(body?.comment);

  // Refused here as well as in the browser. This is the endpoint that changes
  // the worker, and `0.0.0.0/0` reaching it would switch CrowdSec off for every
  // application while looking like an ordinary row in a table.
  const refusal = exemptionRefusal(value);
  if (refusal) return json({ error: refusal }, { status: 400 });

  if (!worker.podmanApiUrl) {
    return json({ error: 'Worker has no Podman API configured.' }, { status: 409 });
  }

  let result: { ok: boolean; message: string; lifted?: number | null } = {
    ok: false,
    message: 'CrowdSec is not running on this worker.',
  };

  await withPodman(worker, async (client) => {
    const session = await openCrowdsec(client);
    if (session.error) {
      result = { ok: false, message: session.error };
      return;
    }

    // Created on every add rather than once at provisioning time. The list is
    // CrowdSec's, not Rudder's — an operator can delete it with `cscli`, and a
    // worker rebuilt from scratch has never had one — so "it exists because we
    // made it earlier" is an assumption this cannot hold. Failing because it is
    // already there is the normal path, not an error.
    const created = await session.exec(exemptionCommands.create());
    if (created.exitCode !== 0 && !listAlreadyExists(created)) {
      result = {
        ok: false,
        message:
          (created.stderr.trim() || created.stdout.trim() || 'Could not create the exemption list.')
            .slice(0, 500),
      };
      return;
    }

    const { stdout, stderr, exitCode, exitCodeKnown } = await session.exec(
      exemptionCommands.add(value, comment),
    );

    // An unread exit code reports 0. Claiming an address is exempt when the
    // worker never confirmed it sends someone away believing a caller is
    // unblocked, which they will only discover is false the next time it breaks.
    if (exitCodeKnown === false) {
      result = {
        ok: false,
        message:
          'Rudder could not confirm the outcome on the worker. Refresh the exemptions ' +
          'list to see whether the address was added.',
      };
      return;
    }

    const said = `${stdout} ${stderr}`;
    result = {
      ok: exitCode === 0,
      message: (stdout.trim() || stderr.trim() || '').slice(0, 500),
      // Allowlisting deletes the decisions that already match, so this number is
      // how many bans the click just lifted. It is the evidence that the thing
      // the operator was fighting has actually stopped.
      lifted: exitCode === 0 ? decisionsLifted(said) : null,
    };
  });

  return json(result, { status: result.ok ? 200 : 502 });
});

/**
 * Withdraw one exemption, putting the address back under CrowdSec's scenarios.
 *
 * The only write on this tab that *restores* protection rather than removing it,
 * which is why it is not guarded by a refusal list the way adding one is: there
 * is no value of `value` that makes a worker less safe here. An address that is
 * not on the list is reported as such by `cscli` and passed through verbatim.
 */
async function removeExemption(worker: any, value: string) {
  if (!worker.podmanApiUrl) {
    return json({ error: 'Worker has no Podman API configured.' }, { status: 409 });
  }

  let result: { ok: boolean; message: string } = {
    ok: false,
    message: 'CrowdSec is not running on this worker.',
  };

  await withPodman(worker, async (client) => {
    const session = await openCrowdsec(client);
    if (session.error) {
      result = { ok: false, message: session.error };
      return;
    }

    const { stdout, stderr, exitCode, exitCodeKnown } = await session.exec(
      exemptionCommands.remove(value),
    );

    // Unconfirmed is not success. Reporting a withdrawal that did not happen
    // leaves an address exempt that everyone believes is protected again —
    // which is the failure nobody goes looking for.
    if (exitCodeKnown === false) {
      result = {
        ok: false,
        message:
          'Rudder could not confirm the outcome on the worker. Refresh the exemptions ' +
          'list to see whether the address was removed.',
      };
      return;
    }

    result = {
      ok: exitCode === 0,
      message: (stdout.trim() || stderr.trim() || '').slice(0, 500),
    };
  });

  return json(result, { status: result.ok ? 200 : 502 });
}

/**
 * Lift one decision, or withdraw one exemption.
 *
 * Admin-only through `requireWorker`, and audited by the hook that classifies
 * every mutating `/api/` request, because one of these removes a security
 * control on a production host and "who lifted that ban" is the question
 * afterwards.
 */
export const DELETE: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const raw = event.url.searchParams.get('decision') ?? '';
  const exemption = (event.url.searchParams.get('exemption') ?? '').trim();

  // Two different removals on one verb, told apart by which parameter is
  // present and never by falling back from one to the other. Lifting a ban and
  // withdrawing an exemption are opposite acts — one restores traffic, the other
  // restores protection — and a request that meant one and performed the other
  // would be silent.
  if (exemption) {
    return removeExemption(worker, exemption);
  }

  // Numeric ids only. `execContainerHttp` takes an argv array, so there is no
  // shell to inject into — but an id is a number, and refusing anything else
  // means a malformed one is a 400 here rather than a confusing `cscli` error.
  if (!/^\d+$/.test(raw)) {
    return json(
      { error: 'A numeric decision id, or an exemption address, is required.' },
      { status: 400 },
    );
  }

  if (!worker.podmanApiUrl) {
    return json({ error: 'Worker has no Podman API configured.' }, { status: 409 });
  }

  let result: { ok: boolean; message: string } = {
    ok: false,
    message: 'CrowdSec is not running on this worker.',
  };

  await withPodman(worker, async (client) => {
    // Through the same restart-aware session as the reads. Safe for a write
    // because `cscli decisions delete --id` is idempotent — the id either still
    // exists or it does not — and because the decisions live in
    // /var/lib/crowdsec/data, which survives the restart along with the ban.
    // Without this, unblocking somebody in the minute after a rule exclusion
    // failed with `aborted` and left the ban in place.
    const session = await openCrowdsec(client);
    if (session.error) {
      result = { ok: false, message: session.error };
      return;
    }

    const { stdout, stderr, exitCode, exitCodeKnown } = await session.exec([
      'cscli', 'decisions', 'delete', '--id', raw,
    ]);

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
