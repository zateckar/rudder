import { json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '#lib/db/index.ts';
import { workers } from '#lib/db/schema.ts';
import { applicationHostnames } from '#lib/server/appsec.ts';
import { requireApplication, route } from '#lib/server/auth.ts';
import { openLearningPilot, sessionIdPattern } from '#lib/server/crowdsec-learning.ts';
import { withPodman } from '#lib/server/podman-client.ts';

const headers = { 'Cache-Control': 'no-store' };

function sameOrigin(event: RequestEvent) {
  return event.request.headers.get('origin') === event.url.origin;
}

async function getPilot(event: RequestEvent) {
  const { application } = await requireApplication(event, event.params.id!);
  if (!application.workerId) return null;
  const [worker, hosts] = await Promise.all([
    db.select().from(workers).where(eq(workers.id, application.workerId)).get(),
    applicationHostnames(application.id),
  ]);
  if (!worker?.podmanApiUrl || hosts.length === 0) return null;
  return withPodman(worker, (client) => openLearningPilot(client, application.id, hosts));
}

export const POST: RequestHandler = route(async (event) => {
  if (!sameOrigin(event)) return json({ error: 'Invalid request origin.' }, { status: 403, headers });
  const pilot = await getPilot(event);
  if (!pilot) return json({ error: 'Learning is unavailable for this application.' }, { status: 409, headers });
  const enrollment = await pilot.create();
  if (!enrollment) return json({ error: 'A learning session is already active.' }, { status: 409, headers });
  return json(enrollment, { status: 201, headers });
});

export const GET: RequestHandler = route(async (event) => {
  const pilot = await getPilot(event);
  const id = event.url.searchParams.get('id');
  if (id === null) return json({ available: !!pilot, latest: pilot ? await pilot.latest() : null }, { headers });
  if (!sessionIdPattern.test(id)) return json({ error: 'Invalid session ID.' }, { status: 400, headers });
  const session = pilot && await pilot.read(id);
  if (!session) return json({ error: 'Learning session not found.' }, { status: 404, headers });
  return json(session, { headers });
});

export const DELETE: RequestHandler = route(async (event) => {
  if (!sameOrigin(event)) return json({ error: 'Invalid request origin.' }, { status: 403, headers });
  const pilot = await getPilot(event);
  const id = event.url.searchParams.get('id') ?? '';
  if (!sessionIdPattern.test(id)) return json({ error: 'Invalid session ID.' }, { status: 400, headers });
  if (!pilot || !await pilot.revoke(id)) return json({ error: 'Learning session not found.' }, { status: 404, headers });
  return new Response(null, { status: 204, headers });
});
