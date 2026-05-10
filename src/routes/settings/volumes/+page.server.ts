import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
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

export const actions: Actions = {
  create: async ({ request, cookies }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
    const sessionId = getSessionIdFromCookies(cookies);
    const userId = await validateSession(sessionId!);
    if (!userId) throw redirect(303, '/login');

    const formData = await request.formData();
    const name = formData.get('name')?.toString();
    const containerPath = formData.get('containerPath')?.toString();
    const sizeLimit = parseInt(formData.get('sizeLimit')?.toString() || '0');
    const teamId = formData.get('teamId')?.toString();
    const workerId = formData.get('workerId')?.toString();

    if (!name || !containerPath || !teamId || !workerId) {
      return { error: 'Missing required fields' };
    }

    await db.insert(volumes).values({
      id: crypto.randomUUID(),
      name,
      containerPath,
      sizeLimit: sizeLimit || null,
      teamId,
      workerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { success: true };
  },
  delete: async ({ request, cookies }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
    const sessionId = getSessionIdFromCookies(cookies);
    const userId = await validateSession(sessionId!);
    if (!userId) throw redirect(303, '/login');

    const formData = await request.formData();
    const id = formData.get('id')?.toString();
    if (!id) return { error: 'Missing ID' };

    await db.delete(volumes).where(eq(volumes.id, id));
    return { success: true };
  }
};
