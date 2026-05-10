import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, notificationChannels, alertRules, alertEvents, teamMembers } from '$lib/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';

export const load = async ({ cookies, url }: { cookies: any; url: URL }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser) throw redirect(303, '/login');
  const urlTeam = url.searchParams.get('team');

  // Load channels
  let channels: any[] = [];
  let rules: any[] = [];

  if (currentUser.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    channels = await db.select().from(notificationChannels).all();
    rules = await db.select().from(alertRules).all();
  } else {
    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
    const teamIds = memberships.map(m => m.teamId);

    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = (currentUser.role === 'admin' || teamIds.includes(urlTeam)) ? [urlTeam] : [];
    }

    if (targetTeamIds.length > 0) {
      channels = await db.select().from(notificationChannels).where(inArray(notificationChannels.teamId, targetTeamIds)).all();
      rules = await db.select().from(alertRules).where(inArray(alertRules.teamId, targetTeamIds)).all();
    } else {
      channels = [];
      rules = [];
    }
  }

  // Load recent alert events (last 20)
  const events = await db.select().from(alertEvents)
    .orderBy(desc(alertEvents.createdAt))
    .limit(20)
    .all();

  return {
    user: currentUser,
    channels: channels.map(ch => ({
      ...ch,
      createdAt: ch.createdAt instanceof Date ? ch.createdAt.toISOString() : new Date(ch.createdAt as any).toISOString(),
      updatedAt: ch.updatedAt instanceof Date ? ch.updatedAt.toISOString() : new Date(ch.updatedAt as any).toISOString(),
    })),
    rules: rules.map(r => ({
      ...r,
      lastTriggeredAt: r.lastTriggeredAt ? (r.lastTriggeredAt instanceof Date ? r.lastTriggeredAt.toISOString() : new Date(r.lastTriggeredAt as any).toISOString()) : null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt as any).toISOString(),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt as any).toISOString(),
    })),
    events: events.map(ev => ({
      ...ev,
      createdAt: ev.createdAt instanceof Date ? ev.createdAt.toISOString() : new Date(ev.createdAt as any).toISOString(),
    })),
  };
};
