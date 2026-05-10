import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';

export const GET: RequestHandler = async (event) => {
  return handleRequest(event);
};

export const POST: RequestHandler = async (event) => {
  return handleRequest(event);
};

async function handleRequest({ params, url, cookies, request }: any) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  let sshPrivateKey: string | null = null;
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      sshPrivateKey = body.sshPrivateKey;
    } catch {
      // Ignore parse errors
    }
  }

  if (!sshPrivateKey) {
    return json({
      events: [],
      count: 0,
      message: 'SSH key required to fetch system logs. Please provide an SSH key.',
    });
  }

  const since = url.searchParams.get('since') || '24 hours ago';
  const lines = url.searchParams.get('lines') || '1000';

  try {
    const sshConfig: SSHConnectionConfig = {
      host: worker.hostname,
      port: worker.sshPort,
      username: worker.sshUser,
      privateKey: sshPrivateKey,
    };

    // Fetch logs using journalctl in compact short-iso format (avoids huge JSON output)
    const command = `journalctl --since "${since}" -n ${lines} --no-pager --output=short-iso`;
    const result = await executeSSHCommand(sshConfig, command);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `journalctl failed with exit code ${result.exitCode}`);
    }

    // short-iso format: "2025-05-07T12:34:56+0000 hostname process[pid]: message"
    const events = result.stdout
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('--'))
      .map(l => {
        const spaceIdx = l.indexOf(' ');
        if (spaceIdx === -1) return null;
        const timestamp = l.substring(0, spaceIdx);
        const rest = l.substring(spaceIdx + 1);
        // rest = "hostname process[pid]: message"
        const colonIdx = rest.indexOf(': ');
        if (colonIdx === -1) return null;
        const message = rest.substring(colonIdx + 2).trim();
        const unitPart = rest.substring(0, colonIdx);
        // last token before colon is "process[pid]", strip pid
        const unitTokens = unitPart.trim().split(/\s+/);
        const unit = (unitTokens[unitTokens.length - 1] || '').replace(/\[\d+\]$/, '');
        return {
          timestamp,
          priority: classifyPriority(message),
          message,
          unit,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    return json({
      events: events.reverse(), // Newest first
      count: events.length,
    });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
}

function classifyPriority(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('failure') || lower.includes('panic') || lower.includes('fatal')) return 'error';
  if (lower.includes('warn') || lower.includes('deprecated')) return 'warning';
  return 'info';
}
