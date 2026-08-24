/**
 * Notification channels.
 *
 * Admin-only, matching `/settings/notifications`, which is where they are
 * managed. Two reasons rather than one: `config` holds the webhook URL, Slack
 * hook or SMTP credentials, and a channel created with no `teamId` is *global*
 * — the previous membership check only fired when a `teamId` was supplied, so
 * any member could create a channel the whole installation would notify
 * through.
 *
 * The rows stay team-scopable in the schema. When section N is finished, the
 * per-team surface belongs here — with the team taken from the caller's
 * membership, not from whatever the body asks for.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { notificationChannels } from '$lib/db/schema';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const rows = await db.select().from(notificationChannels).all();

  const result = rows.map(ch => ({
    ...ch,
    createdAt: ch.createdAt instanceof Date ? ch.createdAt.toISOString() : new Date(ch.createdAt as any).toISOString(),
    updatedAt: ch.updatedAt instanceof Date ? ch.updatedAt.toISOString() : new Date(ch.updatedAt as any).toISOString(),
  }));

  return json(result);
});

export const POST: RequestHandler = route(async (event) => {
  const userId = requireAdminUser(event).user.id;

  const body = await event.request.json();
  const { name, type, config, teamId } = body;

  if (!name || !type || !config) {
    return json({ error: 'name, type, and config are required' }, { status: 400 });
  }

  // `email` is deliberately not creatable. The schema and the dispatcher both
  // still know the type — rows created before this exist — but there is no SMTP
  // path behind it, so a new email channel could only ever fail to deliver. It
  // used to be offered, accepted, and reported as sent; see `sendEmail`.
  if (!['webhook', 'slack'].includes(type)) {
    return json(
      {
        error:
          type === 'email'
            ? 'Email notifications are not available yet — Rudder has no SMTP support. Use a webhook or Slack channel.'
            : 'type must be webhook or slack',
      },
      { status: 400 },
    );
  }

  // Validate config is valid JSON (or already an object)
  let configStr: string;
  if (typeof config === 'string') {
    try {
      JSON.parse(config);
      configStr = config;
    } catch {
      return json({ error: 'config must be valid JSON' }, { status: 400 });
    }
  } else {
    configStr = JSON.stringify(config);
  }

  const now = new Date();
  const id = crypto.randomUUID();

  await db.insert(notificationChannels).values({
    id,
    name,
    type,
    config: configStr,
    enabled: true,
    teamId: teamId || null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return json({ id, name, type }, { status: 201 });
});
