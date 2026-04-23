import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSSHKey, executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker || !worker.sshKeyId) return json({ error: 'Worker not found or SSH not configured' }, { status: 404 });

  // Validate `since` against an allowlist to prevent shell injection.
  // Accepted forms: "N unit ago" (e.g. "2 hours ago") or ISO-8601 datetime.
  const sinceRaw = url.searchParams.get('since') || '24 hours ago';
  const SINCE_RELATIVE = /^\d{1,6} (second|minute|hour|day|week|month)s? ago$/;
  const SINCE_ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
  if (!SINCE_RELATIVE.test(sinceRaw) && !SINCE_ISO.test(sinceRaw)) {
    return json({ error: 'Invalid since parameter' }, { status: 400 });
  }
  const since = sinceRaw;

  const linesRaw = parseInt(url.searchParams.get('lines') || '200', 10);
  const lines = Number.isFinite(linesRaw) && linesRaw > 0 && linesRaw <= 10000 ? linesRaw : 200;

  const grep = url.searchParams.get('grep') || '';

  try {
    const sshKey = await getSSHKey(worker.sshKeyId);
    if (!sshKey) return json({ error: 'SSH key not found' }, { status: 500 });

    const sshConfig: SSHConnectionConfig = {
      host: worker.hostname,
      port: worker.sshPort,
      username: worker.sshUser,
      privateKey: sshKey.privateKey,
    };

    // Escape single quotes in both `since` and `grep` for safe shell embedding.
    const escapeSingleQuote = (s: string) => s.replace(/'/g, "'\\''");

    // Try journalctl first, fall back to /var/log/syslog or /var/log/messages
    let command = `journalctl --since '${escapeSingleQuote(since)}' -n ${lines} --no-pager -o short-iso 2>/dev/null`;
    if (grep) {
      command = `journalctl --since '${escapeSingleQuote(since)}' -n ${lines} --no-pager -o short-iso -g '${escapeSingleQuote(grep)}' 2>/dev/null`;
    }

    let result = await executeSSHCommand(sshConfig, command);

    // If journalctl fails, try traditional log files
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      command = `tail -n ${lines} /var/log/syslog 2>/dev/null || tail -n ${lines} /var/log/messages 2>/dev/null`;
      result = await executeSSHCommand(sshConfig, command);
    }

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return json({ events: [], count: 0, message: 'No syslog data available' });
    }

    const lines2 = result.stdout.trim().split('\n');
    const events = lines2.map(line => {
      // journalctl short-iso format: 2024-01-15T10:30:00+0000 hostname process[pid]: message
      // or syslog: Jan 15 10:30:00 hostname process[pid]: message
      const journalMatch = line.match(/^(\S+)\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)$/);
      if (journalMatch) {
        return {
          timestamp: journalMatch[1],
          host: journalMatch[2],
          process: journalMatch[3],
          pid: journalMatch[4] || null,
          message: journalMatch[5],
          priority: classifyPriority(journalMatch[5]),
        };
      }
      return {
        timestamp: null,
        host: null,
        process: null,
        pid: null,
        message: line,
        priority: 'info',
      };
    }).filter(e => e.message);

    return json({ events, count: events.length });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

function classifyPriority(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('failure') || lower.includes('panic') || lower.includes('fatal')) return 'error';
  if (lower.includes('warn') || lower.includes('deprecated')) return 'warning';
  return 'info';
}
