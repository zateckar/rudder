import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  return json({
    events: [],
    count: 0,
    message: 'Syslog via SSH is disabled. SSH keys are no longer stored server-side. Use the Terminal feature to run journalctl commands directly on the worker.',
  });
};

function classifyPriority(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('failure') || lower.includes('panic') || lower.includes('fatal')) return 'error';
  if (lower.includes('warn') || lower.includes('deprecated')) return 'warning';
  return 'info';
}
