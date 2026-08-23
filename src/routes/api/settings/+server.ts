import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { systemSettings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const allSettings = await db.select().from(systemSettings).all();
  const settings: Record<string, string> = {};
  for (const s of allSettings) {
    settings[s.key] = s.value;
  }

  return json(settings);
});

export const PUT: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const body = await event.request.json();

  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue;

    const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).get();
    if (existing) {
      await db.update(systemSettings)
        .set({ value, updatedAt: new Date() })
        .where(eq(systemSettings.key, key));
    } else {
      await db.insert(systemSettings).values({
        key,
        value,
        updatedAt: new Date(),
      });
    }
  }

  return json({ success: true });
});
