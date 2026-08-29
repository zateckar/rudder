import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { applications } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireApplication, route } from '$lib/server/auth';
import {
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
  const rule = typeof body?.rule === 'string' ? body.rule.trim() : String(body?.rule ?? '').trim();
  // Optional. Present when the exclusion should apply only to requests from one
  // address, which keeps the rule protecting the application against everyone
  // else — the narrower of the two scopes the matches table offers.
  const source = typeof body?.source === 'string' ? body.source.trim() : '';

  if (!host) return json({ error: 'A host is required.' }, { status: 400 });

  // Through the same parser the form uses, so a rule id that would be refused
  // on the application page cannot get in through this door instead.
  // Composed before parsing, so `930100@203.0.113.4` goes through exactly the
  // same validation as a hand-typed entry rather than a looser path of its own.
  const parsed = parseRuleList(joinRuleSource(rule, source || null));
  if (parsed === null || parsed.length !== 1) {
    return json({ error: 'Exactly one valid rule id or name is required.' }, { status: 400 });
  }

  // The anomaly gate is refused here as well as hidden in the UI. The button not
  // being offered is a property of one page; this is a property of the endpoint.
  const refusal = appsecRuleError(parsed);
  if (refusal) return json({ error: refusal }, { status: 400 });

  // The Host header carries the port on entryPoints other than 443. The
  // application's domain never does, so it is stripped before matching —
  // otherwise excluding a rule from an alert on :1443 would silently match no
  // application and report success.
  const domain = host.split(':')[0];

  const found = await db.select().from(applications).where(eq(applications.domain, domain)).get();
  if (!found) {
    return json({ error: `No application on this Rudder serves ${domain}.` }, { status: 404 });
  }

  // Re-fetched through the authorization helper rather than trusting the row
  // above: the lookup is by hostname, which anyone can read off a request, so
  // the team check has to happen before the write.
  const { application: app } = await requireApplication(event, found.id);

  const existing = parseAppsecRules(app.appsecDisabledRules);
  const [addition] = parsed;
  if (existing.includes(addition)) {
    return json({ ok: true, application: app.name, rules: existing, added: false });
  }

  const next = [...existing, addition];
  await db
    .update(applications)
    .set({ appsecDisabledRules: serializeAppsecRules(next), updatedAt: new Date() })
    .where(eq(applications.id, app.id));

  return json({ ok: true, application: app.name, rules: next, added: true });
});
