import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import { applicationHostnames, parseAppsecRules } from '$lib/server/appsec';
import { withPodman } from '$lib/server/podman-client';
import {
  crowdsecReadError,
  decisionsFromExec,
  groupAppsecBySource,
  isRestartSymptom,
  openCrowdsec,
  parseAppsecAlerts,
  parseBanHistory,
  type AppsecSourceGroup,
  type CrowdsecDecision,
  type SourceBanHistory,
} from '$lib/server/crowdsec';

/**
 * GET /api/applications/[id]/appsec
 *
 * What the WAF has matched against this application, grouped by source address.
 *
 * The same evidence exists on the worker page, but that page is admin-only —
 * `requireWorker` refuses everyone else — so the people who actually own an
 * application, and who are the only ones who can say whether a match is
 * legitimate traffic, could not see any of it. Authorised on the *application*
 * instead: a team member of the owning team.
 *
 * The worker's credentials never leave the server. This reads the worker's
 * CrowdSec on the caller's behalf and returns only rows whose Host is this
 * application's domain — filtered inside `groupAppsecBySource` rather than
 * afterwards, so one team cannot read another team's requests through it.
 */
export const GET: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);

  const empty = { sources: [] as AppsecSourceGroup[], available: false, error: '' };

  // Not `application.domain` — that is null for compose and k8s applications,
  // whose hostname lives on their containers. Reading only the application
  // column told a deployed compose application it had no hostname while its own
  // page header linked to it.
  const hosts = await applicationHostnames(application.id);

  if (hosts.length === 0) {
    return json({
      ...empty,
      error:
        'This application has no hostname yet, so the firewall has nothing to attribute to it. ' +
        'Deploy it first.',
    });
  }
  if (!application.workerId) {
    return json({ ...empty, error: 'This application is not assigned to a worker.' });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, application.workerId)).get();
  if (!worker?.podmanApiUrl) {
    return json({ ...empty, error: 'The worker has no Podman API configured.' });
  }

  let sources: AppsecSourceGroup[] = [];
  let decisions: CrowdsecDecision[] = [];
  let banHistory: Record<string, SourceBanHistory> = {};
  let decisionsError = '';
  let error = '';
  /** Set when the only thing wrong is that CrowdSec is coming back up. */
  let restarting = false;

  try {
    await withPodman(worker, async (client) => {
      // Opened rather than looked up, because a restart is a state to sit out
      // rather than a state to report. Applying a rule exclusion restarts
      // CrowdSec, the worker applies it up to a minute after the click, and
      // whoever is still reading this page lands in that window — where every
      // read used to come back red. `openCrowdsec` waits for the container the
      // restart produces and runs the commands against that one.
      const session = await openCrowdsec(client);
      if (session.error) {
        error = session.error;
        decisionsError = session.error;
        restarting = session.restarting;
        return;
      }

      // The two reads are in separate try blocks, and that is the whole point of
      // splitting them. They were already reported apart — one failing must not
      // blank the other — but a throw from either escaped to the outer catch and
      // blanked both, which is exactly what happened when a restart cut the
      // second command: the matches had already been read and were discarded.
      try {
        const { stdout, exitCode } = await session.exec([
          'cscli', 'alerts', 'list', '-a', '--limit', '200', '-o', 'json',
        ]);

        const rows = parseAppsecAlerts(stdout, exitCode);
        if (rows === null) {
          // Distinct from "nothing matched". Saying "all clear" without an answer
          // is the mistake this whole area has already made once.
          error = 'Could not read WAF matches from CrowdSec on this worker.';
        } else {
          sources = groupAppsecBySource(rows, hosts);
        }

        // Bans that have already lapsed, from the same output. Without them a
        // source with four hundred requests and no live ban reads as "the WAF did
        // nothing", when what actually happened is that it was banned hours ago
        // and the ban ran out.
        banHistory = parseBanHistory(stdout, exitCode) ?? {};
      } catch (err) {
        error = crowdsecReadError(err);
        restarting ||= isRestartSymptom(err);
      }

      // Active bans, on the same connection.
      //
      // Every one of them applies to this application: a decision is by source
      // address across the whole worker, so an address banned while probing
      // some other application is an address that cannot reach this one either.
      // Matches say what the WAF noticed; decisions say who is actually being
      // turned away, and an application owner asking "why can't this user reach
      // us" needs the second, not the first.
      try {
        const read = decisionsFromExec(
          await session.exec(['cscli', 'decisions', 'list', '-o', 'json']),
        );
        decisions = read.decisions;
        decisionsError = read.error ?? '';
      } catch (err) {
        decisionsError = crowdsecReadError(err);
        restarting ||= isRestartSymptom(err);
      }
    });
  } catch (err) {
    // Reaching the worker at all, rather than reading CrowdSec on it. Through
    // the same translator so a connection cut here does not read as a different
    // class of problem from one cut a line lower down.
    error = crowdsecReadError(err);
    decisionsError = error;
    restarting = isRestartSymptom(err);
  }

  // What is already off, so the page can say so. Alerts are historical: a rule
  // disabled a minute ago still appears in everything CrowdSec recorded before
  // that, and offering "Disable" again for it reads as the click not having
  // worked.
  return json({
    sources,
    disabledRules: parseAppsecRules(application.appsecDisabledRules).map(String),
    decisions,
    banHistory,
    // Kept apart from `error`: the matches and the bans are two reads, and one
    // failing should not blank the other. A page that showed no bans because
    // the *alerts* query failed would be reassuring and wrong.
    decisionsAvailable: decisionsError === '',
    decisionsError,
    // Whether what went wrong is a restart still finishing. The page renders
    // this as a notice and reloads itself rather than as a failure, because it
    // is the change the operator asked for taking effect — telling them to
    // refresh was making them do by hand what the page can do for them.
    restarting,
    // Lifting a ban is worker-wide, so it stays an admin action. The page needs
    // to know in order to offer it, rather than showing a button that 403s.
    canLiftDecisions: event.locals.auth?.user.role === 'admin',
    workerId: worker.id,
    available: error === '',
    error,
  });
});
