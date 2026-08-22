import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db, safeWorkerColumns, safeUserColumns } from '$lib/db';
import { users, volumes, teams, workers, teamMembers } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

export const load: PageServerLoad = async ({ cookies, url }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) {
    throw redirect(303, '/login');
  }

  const userId = await validateSession(sessionId);
  if (!userId) {
    throw redirect(303, '/login');
  }

  const currentUser = await db.select(safeUserColumns).from(users).where(eq(users.id, userId)).get();
  if (!currentUser) {
    throw redirect(303, '/login');
  }

  // Get user's teams
  const userTeams = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all();
  const teamIds = userTeams.map(t => t.teamId);
  const urlTeam = url.searchParams.get('team');

  // Get volumes (admin sees all, others see their teams')
  let allVolumes: any[] = [];
  if (currentUser.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    allVolumes = await db.select().from(volumes).all();
  } else {
    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = (currentUser.role === 'admin' || teamIds.includes(urlTeam)) ? [urlTeam] : [];
    }

    if (targetTeamIds.length > 0) {
      allVolumes = await db.select().from(volumes).where(inArray(volumes.teamId, targetTeamIds)).all();
    } else {
      allVolumes = [];
    }
  }

  // Get teams and workers for the form
  const allTeams = currentUser.role === 'admin'
    ? await db.select().from(teams).all()
    : await db.select().from(teams).where(eq(teams.id, teamIds[0] || '')).all();
  
  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();

  // Enrich volumes with actual disk usage (best-effort, parallel per worker)
  const enrichedVolumes = allVolumes.map(vol => ({ ...vol, actualSizeMB: null as number | null }));

  return {
    user: currentUser,
    volumes: enrichedVolumes,
    teams: allTeams,
    workers: allWorkers,
  };
};

// No form actions here on purpose.
//
// The page writes through `/api/volumes` and `/api/volumes/[id]`, which is where
// the tenancy rules live: the POST requires an owning team and membership in it,
// and the per-volume routes resolve the volume through `requireVolumeAccess`.
//
// This file used to carry `create` and `delete` actions as well — a second,
// unauthorized write path that nothing in the UI called. They checked only that
// a session existed, so `create` trusted whatever `teamId` was posted (a volume
// planted in another team is mountable into that team's containers) and `delete`
// removed any volume by raw id. Adding the checks here would have meant
// maintaining the same rules in two places; the endpoints already have them.
