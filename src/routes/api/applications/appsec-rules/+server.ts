import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { applications } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import {
  applicationIdForHostname,
  appsecRuleError,
  parseAppsecRules,
  parseRuleList,
  serializeAppsecRules,
} from '$lib/server/appsec';
import { joinRuleSource } from '$lib/appsec-rules';

/**
 * POST /api/applications/appsec-rules
 *
 * Add a WAF rule exclusion to the application serving a hostname.
 *
 * Exists so the CrowdSec tab can offer the action where the evidence is. An
 * operator looking at an alert knows the host and the rule that fired; making
 * them find the application, open its edit form and retype a six-digit number
 * is where the mistakes come from — and the number they would most likely
 * retype is the wrong one, because the rule a *decision* names is the first in
 * the chain rather than the one that scored.
 *
 * Keyed on the hostname rather than an application id because the hostname is
 * the only thing an AppSec alert carries. Hostnames are unique across
 * applications — `assertDomainAvailable` enforces it — so the mapping is exact.
 */
export const POST: RequestHandler = route(async (event) => {
  const body = await event.request.json().catch(() => null);
  const host = typeof body?.host === 'string' ? body.host.trim() : '';
  // Optional. Present when the exclusion should apply only to requests from one
  // address, which keeps the rule protecting the application against everyone
  // else — the narrower of the two scopes the matches table offers.
  const source = typeof body?.source === 'string' ? body.source.trim() : '';

  // One rule or many. A chunked upload trips twenty-odd signatures on the same
  // binary content — the table showed 25 rules against one address — and
  // disabling them one confirmation at a time is both tedious and worse: each
  // write is applied separately, so it restarts CrowdSec on that worker once per
  // rule. A list is one write and one restart.
  const many = Array.isArray(body?.rules) ? body.rules : null;
  const requested = (many ?? [body?.rule])
    .map((r: unknown) => (typeof r === 'string' ? r.trim() : String(r ?? '').trim()))
    .filter((r: string) => r !== '');

  if (!host) return json({ error: 'A host is required.' }, { status: 400 });
  if (requested.length === 0) {
    return json({ error: 'At least one rule id or name is required.' }, { status: 400 });
  }

  // Through the same parser the form uses, so a rule id that would be refused
  // on the application page cannot get in through this door instead.
  // Composed before parsing, so `930100@203.0.113.4` goes through exactly the
  // same validation as a hand-typed entry rather than a looser path of its own.
  //
  // Parsed as one list rather than in a loop: `parseRuleList` is what the form
  // uses, and it is also what drops duplicates, so a selection holding the same
  // rule twice cannot become two entries.
  const parsed = parseRuleList(
    requested.map((r: string) => joinRuleSource(r, source || null)).join(','),
  );
  if (parsed === null || parsed.length === 0) {
    return json({ error: 'A valid rule id or name is required.' }, { status: 400 });
  }

  // The anomaly gate is refused here as well as hidden in the UI. The button not
  // being offered is a property of one page; this is a property of the endpoint.
  const refusal = appsecRuleError(parsed);
  if (refusal) return json({ error: refusal }, { status: 400 });

  // Resolved through `applicationIdForHostname`, which looks at the containers
  // as well as the application row. `applications.domain` is null for compose
  // and k8s applications, so matching on it alone refused to disable anything
  // for them — the button reported "no application serves this host" on the very
  // page that links to that host. It also strips the port, which the Host header
  // carries on entryPoints other than 443 and a domain never does.
  const domain = host.split(':')[0];
  const applicationId = await applicationIdForHostname(domain);
  if (!applicationId) {
    return json({ error: `No application on this Rudder serves ${domain}.` }, { status: 404 });
  }

  // Fetched through the authorization helper rather than trusting the lookup:
  // the key is a hostname, which anyone can read off a request, so the team
  // check has to happen before the write.
  const { application: app } = await requireApplication(event, applicationId);

  const existing = parseAppsecRules(app.appsecDisabledRules);
  const additions = parsed.filter((entry) => !existing.includes(entry));

  // `added` stays a boolean for the single-rule callers that read it, and
  // `addedRules` carries what a multiple selection actually changed. Nothing new
  // is a success, not an error: selecting a rule that a colleague disabled a
  // minute ago should report that, not fail.
  if (additions.length === 0) {
    return json({
      ok: true,
      application: app.name,
      rules: existing,
      added: false,
      addedRules: [],
    });
  }

  const next = [...existing, ...additions];
  await db
    .update(applications)
    .set({ appsecDisabledRules: serializeAppsecRules(next), updatedAt: new Date() })
    .where(eq(applications.id, app.id));

  return json({
    ok: true,
    application: app.name,
    rules: next,
    added: true,
    addedRules: additions.map(String),
  });
});
