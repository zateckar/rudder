/**
 * WebSocket terminal endpoint — SvelteKit-native WebSocket upgrade.
 *
 * The client connects after obtaining a short-lived token from POST /api/terminal/token.
 * Query params: sessionId, containerId (for container exec), workerId (for host shell), token
 */
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateTerminalToken } from '$lib/server/terminal-tokens';
import { getSSHKey, executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function GET({ url }: { url: URL }) {
  const sessionId = url.searchParams.get('sessionId');
  const containerId = url.searchParams.get('containerId');
  const workerIdParam = url.searchParams.get('workerId');
  const authToken = url.searchParams.get('token');

  if (!sessionId || !authToken) {
    return new Response('Missing required parameters', { status: 400 });
  }

  if (!containerId && !workerIdParam) {
    return new Response('Missing containerId or workerId', { status: 400 });
  }

  // Validate single-use token
  const tokenData = validateTerminalToken(authToken);
  if (!tokenData) {
    return new Response('Invalid or expired token', { status: 401 });
  }

  return new Response(null, {
    // @ts-ignore — SvelteKit's native WebSocket extension
    webSocket: {
      accept: async ({ webSocket: ws }: { webSocket: WebSocket }) => {
        try {
          // Determine target worker
          let targetWorkerId: string;
          let mode: 'container' | 'host';

          if (containerId) {
            const container = await db.select().from(containers).where(eq(containers.id, containerId)).get();
            if (!container || !container.workerId) {
              ws.close(1008, 'Container not found');
              return;
            }
            targetWorkerId = container.workerId;
            mode = 'container';
          } else {
            targetWorkerId = workerIdParam!;
            mode = 'host';
          }

          const worker = await db.select().from(workers).where(eq(workers.id, targetWorkerId)).get();
          if (!worker || !worker.sshKeyId) {
            ws.close(1008, 'Worker not configured');
            return;
          }

          const sshKey = await getSSHKey(worker.sshKeyId);
          if (!sshKey) {
            ws.close(1008, 'SSH key not found');
            return;
          }

          const sshConfig: SSHConnectionConfig = {
            host: worker.hostname,
            port: worker.sshPort,
            username: worker.sshUser,
            privateKey: sshKey.privateKey,
          };

          // Auto-close after timeout
          const timeout = setTimeout(() => {
            ws.close(1001, 'Session timeout');
          }, SESSION_TIMEOUT_MS);

          ws.addEventListener('close', () => clearTimeout(timeout));

          if (mode === 'host') {
            await handleHostTerminal(ws, sshConfig);
          } else {
            await handleContainerTerminal(ws, sshConfig, containerId!);
          }
        } catch (error: any) {
          console.error('Terminal error:', error);
          ws.close(1011, 'Internal server error');
        }
      },
    },
  });
}

async function handleHostTerminal(ws: WebSocket, sshConfig: SSHConnectionConfig) {
  ws.send(JSON.stringify({ type: 'connected', message: 'Host terminal ready' }));
  ws.send(`\x1b[1;32m${sshConfig.username}@${sshConfig.host}\x1b[0m\r\n$ `);

  let currentCommand = '';

  ws.addEventListener('message', async (event) => {
    const input = typeof event.data === 'string' ? event.data : event.data.toString();

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

async function handleContainerTerminal(ws: WebSocket, sshConfig: SSHConnectionConfig, containerId: string) {
  ws.send(JSON.stringify({ type: 'connected', message: 'Container terminal ready' }));

  // Write SSH key to temp file
  const tmpKeyFile = join(tmpdir(), `rudder-term-${Date.now()}.pem`);
  writeFileSync(tmpKeyFile, sshConfig.privateKey, { mode: 0o600 });

  const sshProc = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-i', tmpKeyFile,
    '-p', String(sshConfig.port),
    '-t', // Force PTY allocation
    `${sshConfig.username}@${sshConfig.host}`,
    `podman exec -it ${containerId} /bin/sh`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Forward container output to WebSocket
  sshProc.stdout.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
  });
  sshProc.stderr.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
  });

  sshProc.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Container session ended');
    cleanupKeyFile(tmpKeyFile);
  });

  // Forward WebSocket input to container
  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : event.data.toString();
    sshProc.stdin.write(data);
  });

  ws.addEventListener('close', () => {
    sshProc.kill();
    cleanupKeyFile(tmpKeyFile);
  });
}

function cleanupKeyFile(path: string) {
  try { unlinkSync(path); } catch { /* ignore */ }
}
