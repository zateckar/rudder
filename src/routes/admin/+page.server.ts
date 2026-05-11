import { redirect } from '@sveltejs/kit';
import { db, safeUserColumns } from '$lib/db';
import { users, systemSettings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select(safeUserColumns).from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.role !== 'admin') {
    throw redirect(303, '/dashboard');
  }

  const allUsers = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users).all();

  const intervalRow = await db.select().from(systemSettings).where(eq(systemSettings.key, 'metrics_interval_seconds')).get();
  const metricsInterval = intervalRow ? parseInt(intervalRow.value) : 300;

  const retentionRow = await db.select().from(systemSettings).where(eq(systemSettings.key, 'metrics_retention_days')).get();
  const metricsRetentionDays = retentionRow ? parseInt(retentionRow.value) : 30;


  return {
    user: currentUser,
    usersList: allUsers,
    metricsInterval,
    metricsRetentionDays,
  };
};
