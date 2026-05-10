import { redirect } from '@sveltejs/kit';
import { db, safeUserColumns } from '$lib/db';
import { auditLogs, users } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const load = async ({ cookies, url }: { cookies: any; url: URL }) => {
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
  const urlTeam = url.searchParams.get('team');

  if (currentUser?.role !== 'admin') {
    throw redirect(303, '/dashboard');
  }

  let query = db.select({
    id: auditLogs.id,
    action: auditLogs.action,
    resourceType: auditLogs.resourceType,
    resourceId: auditLogs.resourceId,
    details: auditLogs.details,
    createdAt: auditLogs.createdAt,
    user: {
      username: users.username,
      email: users.email,
    }
  })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id));

  if (urlTeam && urlTeam !== 'all') {
    (query as any) = query.where(eq(auditLogs.teamId, urlTeam));
  }

  const logs = await query
    .orderBy(desc(auditLogs.createdAt))
    .limit(100)
    .all();

  return {
    user: currentUser,
    logs,
  };
};
