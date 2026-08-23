import { db } from '$lib/db';
import { auditLogs, users } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals; url: URL }) => {
  const currentUser = requirePageAdmin(event).user;
  const urlTeam = event.url.searchParams.get('team');

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
