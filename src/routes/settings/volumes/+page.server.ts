import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/db';
import { users, volumes, teams, workers, teamMembers, sshKeys } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand } from '$lib/server/ssh';
import { decrypt } from '$lib/server/encryption';

/** Query volume disk usage from a worker via SSH. */
async function getVolumeUsageMB(worker: typeof workers.$inferSelect, volumeName: string): Promise<number | null> {
  try {
    const sshKey = worker.sshKeyId
      ? await db.select().from(sshKeys).where(eq(sshKeys.id, worker.sshKeyId)).get()
      : null;
    if (!sshKey) return null;

    const result = await executeSSHCommand(
      { host: worker.hostname, port: worker.sshPort, username: worker.sshUser, privateKey: decrypt(sshKey.privateKey) },
      `du -sm /var/lib/containers/storage/volumes/${volumeName}/_data 2>/dev/null | cut -f1`
    );
    const mb = parseInt(result.stdout.trim());
    return isNaN(mb) ? null : mb;
  } catch {
    return null;
  }
}

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
  const enrichedVolumes = await Promise.all(
    allVolumes.map(async (vol) => {
      let actualSizeMB: number | null = null;
      if (vol.workerId) {
        const worker = workerMap.get(vol.workerId);
        if (worker && worker.status === 'online') {
          actualSizeMB = await getVolumeUsageMB(worker, vol.name);
        }
      }
      return { ...vol, actualSizeMB };
    })
  );

  return {
    user: currentUser,
    volumes: enrichedVolumes,
    teams: allTeams,
    workers: allWorkers,
  };
};
