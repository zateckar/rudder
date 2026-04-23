import { redirect } from '@sveltejs/kit';
import { db } from '$lib/db';
import { auditLogs, users } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const load = async ({ cookies }: { cookies: any }) => {
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

  if (currentUser?.role !== 'admin') {
    throw redirect(303, '/dashboard');
  }

  const logs = await db.select({
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
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100)
    .all();

  return {
    user: currentUser,
    logs,
  };
};
