import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand, type SSHConnectionConfig } from '$lib/server/ssh';
import { validateTerminalToken } from '$lib/server/terminal-tokens';

interface TerminalSession {
  ws: WebSocket;
  containerId?: string;
  workerId: string;
  podmanClient?: any;
  containerWs?: WebSocket;
  mode: 'container' | 'host';
  createdAt: Date;
  cleanupTimer?: NodeJS.Timeout;
}

const terminalSessions = new Map<string, TerminalSession>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max session lifetime
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Cleanup every 5 minutes

function scheduleSessionCleanup(sessionId: string, session: TerminalSession): void {
  session.cleanupTimer = setTimeout(() => {
    const s = terminalSessions.get(sessionId);
    if (s && s.ws.readyState !== WebSocket.CLOSED) {
      console.warn(`Terminal session ${sessionId} timed out, closing`);
      s.ws.close(1001, 'Session timeout');
    }
    cleanupTerminalSession(sessionId);
  }, SESSION_TIMEOUT_MS);
}

function runPeriodicCleanup(): void {
  const now = Date.now();
  for (const [sessionId, session] of terminalSessions.entries()) {
    const age = now - session.createdAt.getTime();
    const wsClosed = session.ws.readyState === WebSocket.CLOSED;
    
    if (wsClosed || age > SESSION_TIMEOUT_MS) {
      console.warn(`Cleaning up stale terminal session ${sessionId} (age: ${Math.round(age/1000)}s, wsClosed: ${wsClosed})`);
      cleanupTerminalSession(sessionId);
    }
  }
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function initializeTerminalServer(server: Server) {
  const wss = new WebSocketServer({ 
    server,
    path: '/api/terminal/ws'
  });

  // Start periodic cleanup if not already running
  if (!cleanupInterval) {
    cleanupInterval = setInterval(runPeriodicCleanup, CLEANUP_INTERVAL_MS);
    cleanupInterval.unref(); // Don't prevent process exit
  }

  wss.on('connection', async (ws: WebSocket, req) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId');
      const containerId = url.searchParams.get('containerId');
      const workerIdParam = url.searchParams.get('workerId');
      const authToken = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');

      if (!sessionId || !authToken) {
        ws.close(1008, 'Missing required parameters');
        return;
      }

      if (!containerId && !workerIdParam) {
        ws.close(1008, 'Missing containerId or workerId');
        return;
      }

      const tokenData = await validateTerminalSession(authToken);
      if (!tokenData) {
        ws.close(1008, 'Invalid authorization');
        return;
      }

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

      let sshConfig: SSHConnectionConfig | null = null;

      if (mode === 'host') {
        // SSH key must be provided ad-hoc by the client (never stored server-side)
        ws.send(JSON.stringify({ type: 'need_ssh_key', message: 'Please provide SSH private key' }));

        const privateKey = await new Promise<string | null>((resolve) => {
          const keyTimeout = setTimeout(() => resolve(null), 30000);
          ws.once('message', (data: Buffer) => {
            clearTimeout(keyTimeout);
            try {
              const msg = JSON.parse(data.toString());
              resolve(msg.type === 'ssh_key' && msg.key ? msg.key : null);
            } catch {
              resolve(null);
            }
          });
        });

        if (!privateKey) {
          ws.close(1008, 'SSH key not provided');
          return;
        }

        sshConfig = {
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey,
        };
      }

      let containerPodmanClient: any = null;

      if (mode === 'container') {
        const { getRestPodmanClient } = await import('$lib/server/podman-client');
        try {
          containerPodmanClient = getRestPodmanClient(worker);
        } catch (e: any) {
          ws.close(1011, 'Podman REST API not available for this worker');
          return;
        }
      }

      const session: TerminalSession = {
        ws,
        containerId: containerId || undefined,
        workerId: targetWorkerId,
        podmanClient: containerPodmanClient,
        mode,
        createdAt: new Date(),
      };

      terminalSessions.set(sessionId, session);
      scheduleSessionCleanup(sessionId, session);

      if (mode === 'host' && sshConfig) {
        await setupHostTerminal(session, sshConfig);
      } else {
        await setupTerminalConnection(session);
      }

      ws.on('close', () => {
        cleanupTerminalSession(sessionId);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        cleanupTerminalSession(sessionId);
      });

      ws.on('message', async (data) => {
        try {
          if (session.containerWs && session.containerWs.readyState === WebSocket.OPEN) {
            session.containerWs.send(data);
          }
        } catch (error) {
          console.error('Error forwarding data:', error);
        }
      });

    } catch (error) {
      console.error('Error establishing terminal connection:', error);
      ws.close(1011, 'Internal server error');
    }
  });

  return wss;
}

async function setupHostTerminal(session: TerminalSession, sshConfig: SSHConnectionConfig) {
  if (session.ws.readyState !== WebSocket.OPEN) return;

  session.ws.send(JSON.stringify({ type: 'connected', message: 'Host terminal ready' }));
  session.ws.send(`\x1b[1;32m${sshConfig.username}@${sshConfig.host}\x1b[0m\r\n`);

  let currentCommand = '';
  let commandHistory: string[] = [];
  let historyIndex = -1;

  // Send initial prompt
  session.ws.send('$ ');

  session.ws.on('message', async (data) => {
    const input = data.toString();

    for (const char of input) {
      if (char === '\r' || char === '\n') {
        session.ws.send('\r\n');
        const trimmed = currentCommand.trim();

        if (trimmed === 'clear') {
          session.ws.send('\x1b[2J\x1b[H');
          currentCommand = '';
          historyIndex = -1;
          session.ws.send('$ ');
          return;
        }

        if (trimmed) {
          commandHistory.push(trimmed);
          if (commandHistory.length > 100) commandHistory.shift();
          try {
            const result = await executeSSHCommand(sshConfig, trimmed);
            if (result.stdout) session.ws.send(result.stdout.replace(/\n/g, '\r\n'));
            if (result.stderr) session.ws.send(`\x1b[31m${result.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
          } catch (error: any) {
            session.ws.send(`\x1b[31mError: ${error.message}\r\n\x1b[0m`);
          }
        }
        currentCommand = '';
        historyIndex = -1;
        session.ws.send('$ ');
      } else if (char === '\x7f' || char === '\b') {
        if (currentCommand.length > 0) {
          currentCommand = currentCommand.slice(0, -1);
          session.ws.send('\b \b');
        }
      } else if (char === '\x1b') {
        // Skip escape sequences (arrow keys etc.) - read next 2 chars
        // They'll be handled as non-printable below
      } else if (char === '\x03') {
        // Ctrl+C
        currentCommand = '';
        session.ws.send('^C\r\n$ ');
      } else if (char === '\x04') {
        // Ctrl+D
        session.ws.send('\r\nlogout\r\n');
        session.ws.close(1000, 'User disconnected');
      } else if (char >= ' ') {
        currentCommand += char;
        session.ws.send(char);
      }
    }
  });
}

async function setupTerminalConnection(session: TerminalSession) {
  if (!session.podmanClient || !session.containerId) return;
  const containerId = session.containerId;
  try {
    // Check if client supports WebSocket-based execContainer (REST API)
    if ('execContainer' in session.podmanClient && typeof (session.podmanClient as any).execContainer === 'function') {
      try {
        const result = await (session.podmanClient as any).execContainer(
          session.containerId,
          ['/bin/sh'],
          {
            attachStdin: true,
            attachStdout: true,
            attachStderr: true,
            tty: true
          }
        );

        // Check if result is a WebSocket (REST API) or an object with stdout/stderr (SSH)
        if (result && typeof result.on === 'function') {
          // WebSocket - REST API client
          session.containerWs = result;

          // Forward output from container to client
          result.on('message', (data: any) => {
            if (session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(data.toString());
            }
          });

          result.on('error', (error: any) => {
            console.error('Container WebSocket error:', error);
            if (session.ws.readyState === WebSocket.OPEN) {
              session.ws.close(1011, 'Container terminal error');
            }
          });

          result.on('close', () => {
            if (session.ws.readyState === WebSocket.OPEN) {
              session.ws.close(1000, 'Terminal session ended');
            }
          });

          // Send initial connection success message
          if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'connected', message: 'Terminal session established' }));
          }
          return;
        }
      } catch (e) {
        // WebSocket exec failed, fall through to SSH handling
        console.error('WebSocket exec failed:', e);
      }
    }

    // SSH fallback removed — container terminals require Podman REST API
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'error', message: 'Container terminal requires Podman REST API. This worker does not support SSH-based exec.' }));
      session.ws.close(1011, 'Podman REST API required for container terminals');
    }

  } catch (error) {
    console.error('Failed to setup terminal connection:', error);
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close(1011, 'Failed to establish terminal connection');
    }
  }
}

function cleanupTerminalSession(sessionId: string) {
  const session = terminalSessions.get(sessionId);
  if (session) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
    if (session.containerWs && session.containerWs.readyState !== WebSocket.CLOSED) {
      session.containerWs.close();
    }
    if (session.podmanClient) {
      session.podmanClient.destroy();
    }
    if (session.ws.readyState !== WebSocket.CLOSED) {
      session.ws.close(1001, 'Session cleanup');
    }
    terminalSessions.delete(sessionId);
  }
}

async function validateTerminalSession(token: string): Promise<{ containerId?: string; workerId?: string; userId: string } | null> {
  try {
    return validateTerminalToken(token);
  } catch (error) {
    console.error('Error validating terminal session:', error);
    return null;
  }
}

export function getTerminalSession(sessionId: string): TerminalSession | undefined {
  return terminalSessions.get(sessionId);
}
