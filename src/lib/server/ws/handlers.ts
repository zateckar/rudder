/**
 * Every WebSocket route the app serves, registered once at startup.
 *
 * Imported from `hooks.server.ts` so the handlers are registered inside the
 * app's own module graph — same database connection, same Podman clients — and
 * the HTTP server merely dispatches to them. See `./registry.ts` for why the
 * upgrade cannot be handled in a `+server.ts`.
 */
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { db } from '$lib/db';
import { applications, containers, teams, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateTerminalToken } from '$lib/server/terminal-tokens';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
import { authenticateK8s } from '$lib/server/k8s/auth';
import { containerKeyOf, podGroupsFor, podNameOf } from '$lib/server/k8s/mapper';
import {
  CHANNEL,
  frame,
  parseFrame,
  selectChannelProtocol,
  statusFrame,
} from '$lib/server/k8s/channel';
import { registerWsRoute } from './registry';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** `authenticateK8s` takes a fetch Request; upgrades arrive as IncomingMessage. */
function toFetchRequest(request: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  return new Request(url.toString().replace(/^ws/, 'http'), { headers });
}

// ── /api/terminal/ws — the UI's container and host terminal ──────────────────

registerWsRoute('terminal', {
  match: (url) => url.pathname === '/api/terminal/ws',
  handle: async (ws, _request, url) => {
    const authToken = url.searchParams.get('token');
    if (!authToken) {
      ws.close(1008, 'Missing token');
      return;
    }

    // The token is the only authorization signal, so the target is read from
    // the token itself — never from the query string, which the caller
    // controls.
    const tokenData = validateTerminalToken(authToken);
    if (!tokenData) {
      ws.close(1008, 'Invalid or expired token');
      return;
    }

    const containerId = tokenData.containerId ?? null;
    const workerIdParam = tokenData.workerId ?? null;
    if (!containerId && !workerIdParam) {
      ws.close(1008, 'Token is not bound to a container or worker');
      return;
    }

    let targetWorkerId: string;
    if (containerId) {
      const container = await db.select().from(containers).where(eq(containers.id, containerId)).get();
      if (!container?.workerId) {
        ws.close(1008, 'Container not found');
        return;
      }
      targetWorkerId = container.workerId;
    } else {
      targetWorkerId = workerIdParam!;
    }

    const worker = await db.select().from(workers).where(eq(workers.id, targetWorkerId)).get();
    if (!worker) {
      ws.close(1008, 'Worker not configured');
      return;
    }

    const timeout = setTimeout(() => ws.close(1001, 'Session timeout'), SESSION_TIMEOUT_MS);
    ws.on('close', () => clearTimeout(timeout));

    if (containerId) {
      await handleContainerTerminal(ws, worker, containerId);
    } else {
      // The SSH key is never stored server-side; the browser supplies it for
      // this session only.
      ws.send(JSON.stringify({ type: 'need_ssh_key', message: 'Please provide SSH key' }));
      ws.once('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ssh_key' && msg.key) {
            await handleHostTerminal(ws, {
              host: worker.hostname,
              port: worker.sshPort,
              username: worker.sshUser,
              privateKey: msg.key,
            });
          } else {
            ws.close(1008, 'Invalid SSH key message');
          }
        } catch {
          ws.close(1008, 'Failed to parse SSH key message');
        }
      });
    }
  },
});

/**
 * Host "terminal".
 *
 * Each line is run as its own SSH invocation, so there is no shell session:
 * `cd`, exported variables and interactive programs do not persist between
 * commands. The banner says so rather than leaving users to discover it.
 */
async function handleHostTerminal(ws: WebSocket, sshConfig: SSHConnectionConfig) {
  ws.send(JSON.stringify({ type: 'connected', message: 'Host terminal ready' }));
  ws.send(`\x1b[1;32m${sshConfig.username}@${sshConfig.host}\x1b[0m\r\n`);
  ws.send(
    `\x1b[2mEach command runs in its own SSH session — 'cd' and shell variables ` +
      `do not carry over. Chain with && for multi-step commands.\x1b[0m\r\n$ `,
  );

  let currentCommand = '';

  ws.on('message', async (raw) => {
    const input = raw.toString();

    for (const char of input) {
      if (char === '\r' || char === '\n') {
        ws.send('\r\n');
        const trimmed = currentCommand.trim();

        if (trimmed === 'clear') {
          ws.send('\x1b[2J\x1b[H');
          currentCommand = '';
          ws.send('$ ');
          return;
        }

        if (trimmed) {
          try {
            const result = await executeSSHCommand(sshConfig, trimmed);
            if (result.stdout) ws.send(result.stdout.replace(/\n/g, '\r\n'));
            if (result.stderr) ws.send(`\x1b[31m${result.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
          } catch (error: any) {
            ws.send(`\x1b[31mError: ${error.message}\r\n\x1b[0m`);
          }
        }
        currentCommand = '';
        ws.send('$ ');
      } else if (char === '\x7f' || char === '\b') {
        if (currentCommand.length > 0) {
          currentCommand = currentCommand.slice(0, -1);
          ws.send('\b \b');
        }
      } else if (char === '\x03') {
        currentCommand = '';
        ws.send('^C\r\n$ ');
      } else if (char === '\x04') {
        ws.send('\r\nlogout\r\n');
        ws.close(1000, 'User disconnected');
      } else if (char >= ' ') {
        currentCommand += char;
        ws.send(char);
      }
    }
  });
}

async function handleContainerTerminal(ws: WebSocket, worker: any, containerRowId: string) {
  const container = await db.select().from(containers).where(eq(containers.id, containerRowId)).get();
  if (!container) {
    ws.close(1008, 'Container not found');
    return;
  }

  ws.send(JSON.stringify({ type: 'connected', message: 'Container terminal ready' }));

  let client;
  try {
    client = getRestPodmanClient(worker);
  } catch (e: any) {
    ws.send(`\x1b[31mError: Cannot connect to Podman REST API: ${e.message}\r\n\x1b[0m`);
    ws.close(1011, 'Podman REST API not available');
    return;
  }

  try {
    const exec = await client.execContainerStream(container.containerId, ['/bin/sh'], {
      tty: true,
      stdin: true,
    });

    if (!exec.stdinAvailable) {
      // Better to say so than to render a prompt that ignores every keystroke.
      ws.send(
        '\x1b[33mThis worker\'s Podman API is reached through Traefik, which does not ' +
          'proxy the connection upgrade an interactive session needs.\x1b[0m\r\n' +
          '\x1b[2mCommands still run — use the non-interactive exec — but there is no ' +
          'shell input here.\x1b[0m\r\n',
      );
    }

    exec.onStdout((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data.toString());
    });
    exec.onEnd(() => {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'Container session ended');
      client.destroy();
    });

    ws.on('message', (raw) => exec.write(raw as Buffer));
    ws.on('close', () => {
      exec.close();
      client.destroy();
    });
  } catch (e: any) {
    ws.send(`\x1b[31mError: ${e.message}\r\n\x1b[0m`);
    ws.close(1011, 'Failed to exec into container');
    client.destroy();
  }
}

// ── kubectl exec ─────────────────────────────────────────────────────────────

const EXEC_PATH = /^\/k8s\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/exec$/;

registerWsRoute('k8s-exec', {
  match: (url) => EXEC_PATH.test(url.pathname),
  selectProtocol: (offered) => selectChannelProtocol(offered),
  handle: async (ws, request, url) => {
    const match = EXEC_PATH.exec(url.pathname)!;
    const [, ns, podName] = match.map(decodeURIComponent);

    const fail = (message: string, code = 1008) => {
      // Send the Status first: kubectl prints the error channel's message,
      // whereas a bare close code surfaces as "connection closed unexpectedly".
      try {
        ws.send(frame(CHANNEL.ERROR, JSON.stringify({
          kind: 'Status', apiVersion: 'v1', metadata: {},
          status: 'Failure', message, reason: 'Forbidden',
        })));
      } catch { /* socket already gone */ }
      ws.close(code, message);
    };

    const ctx = await authenticateK8s(toFetchRequest(request, url));
    if (!ctx) return fail('Unauthorized');

    const team = await db.select().from(teams).where(eq(teams.slug, ns)).get();
    if (!team || (!ctx.isGlobal && ctx.teamId !== team.id)) {
      // Same message either way: whether a namespace exists is not something an
      // unauthorised caller should be able to probe.
      return fail(`pods "${podName}" not found`);
    }

    // kubectl sends ?container= when a Pod has more than one, which a
    // Kubernetes application's Pod now does.
    const found = await findTeamContainer(team.id, podName, url.searchParams.get('container'));
    if (found && 'choices' in found) {
      return fail(
        `container ${url.searchParams.get('container')} is not valid for pod ${podName}; ` +
          `choose one of: [${found.choices.join(' ')}]`,
      );
    }
    const container = found;
    if (!container?.workerId) return fail(`pods "${podName}" not found`);

    const worker = await db.select().from(workers).where(eq(workers.id, container.workerId)).get();
    if (!worker) return fail('worker not available', 1011);

    // kubectl repeats ?command= once per argv element.
    const command = url.searchParams.getAll('command');
    const cmd = command.length > 0 ? command : ['/bin/sh'];
    const tty = url.searchParams.get('tty') === 'true';

    let client;
    try {
      client = getRestPodmanClient(worker);
    } catch (e: any) {
      return fail(`cannot reach the worker's Podman API: ${e.message}`, 1011);
    }

    let exec;
    try {
      exec = await client.execContainerStream(container.containerId, cmd, {
        tty,
        stdin: url.searchParams.get('stdin') === 'true',
      });
    } catch (e: any) {
      client.destroy();
      return fail(`exec failed: ${e.message}`, 1011);
    }

    if (url.searchParams.get('stdin') === 'true' && !exec.stdinAvailable) {
      // `kubectl exec -i` asked for stdin and cannot have it. Say why on the
      // error channel — kubectl prints that message — instead of running the
      // command with a silently empty stdin, which for `-i` pipelines would
      // look like the input was consumed.
      exec.close();
      client.destroy();
      return fail(
        'stdin is not available for exec on this worker: its Podman API is reached through ' +
          'Traefik, which does not proxy the connection upgrade required to attach stdin. ' +
          'Run without -i / -it.',
        1011,
      );
    }

    // In TTY mode the pty has already merged the streams, so everything is
    // stdout — which is what kubectl expects for `-t`. Without a TTY the
    // Podman stream is demultiplexed for us, so stderr stays on its own
    // channel and `kubectl exec … 2>/dev/null` behaves.
    exec.onStdout((data) => {
      if (ws.readyState === ws.OPEN) ws.send(frame(CHANNEL.STDOUT, data));
    });
    exec.onStderr((data) => {
      if (ws.readyState === ws.OPEN) ws.send(frame(CHANNEL.STDERR, data));
    });

    exec.onEnd(async () => {
      if (ws.readyState !== ws.OPEN) {
        client.destroy();
        return;
      }
      // The exit code is what kubectl turns into its own exit status, so it is
      // read back rather than assumed — `kubectl exec … && something` depends
      // on it being right.
      const { exitCode } = await exec.inspect();
      try { ws.send(statusFrame(exitCode, cmd)); } catch { /* closing */ }
      ws.close(1000, 'exec finished');
      client.destroy();
    });

    ws.on('message', (raw) => {
      const parsed = parseFrame(Buffer.from(raw as any));
      if (!parsed) return;
      if (parsed.channel === CHANNEL.STDIN) exec.write(parsed.payload);
      // RESIZE is accepted and ignored: Podman's exec API has no resize call
      // on this path. Dropping the frame is invisible; treating it as stdin
      // would type JSON into the user's shell.
    });

    ws.on('close', () => {
      exec.close();
      client.destroy();
    });
  },
});

/**
 * Find the container an exec should run in, by pod name within one team.
 *
 * A Kubernetes application's Pod holds every container it applied, so the
 * caller's `?container=` selects between them; without one, the first is used,
 * which is what kubectl assumes for a single-container Pod. Returns the
 * available names instead when the selection does not match, so the error can
 * say what to choose rather than "not found".
 */
async function findTeamContainer(teamId: string, podName: string, containerName?: string | null) {
  const teamApps = await db.select().from(applications).where(eq(applications.teamId, teamId)).all();
  const wanted = podNameOf(podName);

  for (const app of teamApps) {
    const appContainers = await db
      .select()
      .from(containers)
      .where(eq(containers.applicationId, app.id))
      .all();

    const group =
      podGroupsFor(app, appContainers).find((g) => g.name === wanted) ??
      (appContainers.some((c) => podNameOf(c.name) === wanted)
        ? { name: wanted, rows: appContainers.filter((c) => podNameOf(c.name) === wanted) }
        : null);
    if (!group) continue;

    if (!containerName) return group.rows[0];
    const selected = group.rows.find((r) => containerKeyOf(r) === containerName);
    return selected ?? { choices: group.rows.map(containerKeyOf) };
  }
  return null;
}
