import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/db';
import { users, volumes, teams, workers, teamMembers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async ({ cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) {
    throw redirect(303, '/login');
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    throw redirect(303, '/login');
  }

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser) {
    throw redirect(303, '/login');
  }

  // Get user's teams
  const userTeams = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
  const teamIds = userTeams.map(t => t.teamId);

  // Get volumes (admin sees all, others see their teams')
  let allVolumes;
  if (currentUser.role === 'admin') {
    allVolumes = await db.select().from(volumes).all();
  } else {
    allVolumes = (await db.select().from(volumes).all()).filter(
      v => v.teamId && teamIds.includes(v.teamId)
    );
  }

  // Get teams and workers for the form
  const allTeams = currentUser.role === 'admin'
    ? await db.select().from(teams).all()
    : await db.select().from(teams).where(eq(teams.id, teamIds[0] || '')).all();
  
  const allWorkers = await db.select().from(workers).all();
  const workerMap = new Map(allWorkers.map(w => [w.id, w]));

  // Enrich volumes with actual disk usage (best-effort, parallel per worker)
  const enrichedVolumes = allVolumes.map(vol => ({ ...vol, actualSizeMB: null as number | null }));

  return {
    user: currentUser,
    volumes: enrichedVolumes,
    teams: allTeams,
    workers: allWorkers,
  };
};
