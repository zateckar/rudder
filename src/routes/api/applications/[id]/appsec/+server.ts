import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import { parseAppsecRules } from '$lib/server/appsec';
import { withPodman } from '$lib/server/podman-client';
import {
  findCrowdsecContainer,
  groupAppsecBySource,
  parseAppsecAlerts,
  type AppsecSourceGroup,
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

  if (!application.domain) {
    return json({ ...empty, error: 'This application has no hostname, so the WAF cannot attribute anything to it.' });
  }
  if (!application.workerId) {
    return json({ ...empty, error: 'This application is not assigned to a worker.' });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, application.workerId)).get();
  if (!worker?.podmanApiUrl) {
    return json({ ...empty, error: 'The worker has no Podman API configured.' });
  }

  let sources: AppsecSourceGroup[] = [];
  let error = '';

  try {
    await withPodman(worker, async (client) => {
      const container = await findCrowdsecContainer(client);
      if (!container) {
        error = 'CrowdSec is not running on this worker.';
        return;
      }

      const { stdout, exitCode } = await client.execContainerHttp(
        container.Id,
        ['cscli', 'alerts', 'list', '-a', '--limit', '200', '-o', 'json'],
        { attachStdout: true, attachStderr: true, tty: false },
      );

      const rows = parseAppsecAlerts(stdout, exitCode);
      if (rows === null) {
        // Distinct from "nothing matched". Saying "all clear" without an answer
        // is the mistake this whole area has already made once.
        error = 'Could not read WAF matches from CrowdSec on this worker.';
        return;
      }
      sources = groupAppsecBySource(rows, application.domain!);
    });
  } catch (err: any) {
    error = `Could not reach the worker: ${err?.message ?? String(err)}`;
  }

  // What is already off, so the page can say so. Alerts are historical: a rule
  // disabled a minute ago still appears in everything CrowdSec recorded before
  // that, and offering "Disable" again for it reads as the click not having
  // worked.
  return json({
    sources,
    disabledRules: parseAppsecRules(application.appsecDisabledRules).map(String),
    available: error === '',
    error,
  });
});
