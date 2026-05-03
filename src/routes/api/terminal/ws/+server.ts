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
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
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
          if (!worker) {
            ws.close(1008, 'Worker not configured');
            return;
          }

          // Auto-close after timeout
          const timeout = setTimeout(() => {
            ws.close(1001, 'Session timeout');
          }, SESSION_TIMEOUT_MS);

          ws.addEventListener('close', () => clearTimeout(timeout));

          if (mode === 'host') {
            // SSH key must be provided ad-hoc by client (never stored server-side)
            ws.send(JSON.stringify({ type: 'need_ssh_key', message: 'Please provide SSH key' }));
            const keyHandler = async (event: MessageEvent) => {
              ws.removeEventListener('message', keyHandler as any);
              try {
                const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
                if (msg.type === 'ssh_key' && msg.key) {
                  const sshConfig: SSHConnectionConfig = {
                    host: worker.hostname,
                    port: worker.sshPort,
                    username: worker.sshUser,
                    privateKey: msg.key,
                  };
                  await handleHostTerminal(ws, sshConfig);
                } else {
                  ws.close(1008, 'Invalid SSH key message');
                }
              } catch {
                ws.close(1008, 'Failed to parse SSH key message');
              }
            };
            ws.addEventListener('message', keyHandler as any);
          } else {
            // Container terminal uses Podman REST API (no SSH needed)
            await handleContainerTerminal(ws, worker, containerId!);
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

async function handleContainerTerminal(ws: WebSocket, worker: any, containerId: string) {
  ws.send(JSON.stringify({ type: 'connected', message: 'Container terminal ready' }));

  // Use Podman REST API WebSocket instead of SSH
  const { getRestPodmanClient } = await import('$lib/server/podman-client');
  
  let client;
  try {
    client = getRestPodmanClient(worker);
  } catch (e: any) {
    ws.send(`\x1b[31mError: Cannot connect to Podman REST API: ${e.message}\r\n\x1b[0m`);
    ws.close(1011, 'Podman REST API not available');
    return;
  }

  try {
    const containerWs = await client.execContainer(containerId, ['/bin/sh'], {
      attachStdin: true,
      attachStdout: true,
      attachStderr: true,
      tty: true,
    });

    // Forward container output to client WebSocket
    containerWs.on('message', (data: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(typeof data === 'string' ? data : data.toString());
      }
    });

    containerWs.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Container session ended');
      client.destroy();
    });

    containerWs.on('error', (err: any) => {
      console.error('Container WebSocket error:', err);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Container connection error');
      client.destroy();
    });

    // Forward client input to container
    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : event.data.toString();
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(data);
      }
    });

    ws.addEventListener('close', () => {
      containerWs.close();
      client.destroy();
    });
  } catch (e: any) {
    ws.send(`\x1b[31mError: ${e.message}\r\n\x1b[0m`);
    ws.close(1011, 'Failed to exec into container');
    client.destroy();
  }
}

function cleanupKeyFile(path: string) {
  try { unlinkSync(path); } catch { /* ignore */ }
}
