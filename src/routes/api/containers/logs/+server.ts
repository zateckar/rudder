import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export async function GET({ url, cookies }: { url: URL; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const containerIdParam = url.searchParams.get('containerId');
  const tail = parseInt(url.searchParams.get('tail') || '1000');
  const follow = url.searchParams.get('follow') === 'true';

  if (!containerIdParam) {
    return json({ error: 'Container ID required' }, { status: 400 });
  }

  const container = await db.select().from(containers).where(eq(containers.id, containerIdParam)).get();
  
  if (!container || !container.workerId) {
    return json({ error: 'Container not found or no worker assigned' }, { status: 404 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, container.workerId)).get();
  
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  let client: ReturnType<typeof getRestPodmanClient>;
  try {
    client = getRestPodmanClient(worker);
  } catch (e: any) {
    return json({ error: `Client creation failed: ${e.message}` }, { status: 400 });
  }

  if (follow) {
    // Stream logs using Server-Sent Events
    const encoder = new TextEncoder();
    let controllerClosed = false;
    let abortFn: (() => void) | null = null;
    
    const stream = new ReadableStream({
      start(controller) {
        const safeEnqueue = (data: Uint8Array) => {
          if (!controllerClosed) {
            try {
              controller.enqueue(data);
            } catch {
              controllerClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!controllerClosed) {
            controllerClosed = true;
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }
          if (abortFn) {
            abortFn();
          }
          client.destroy();
        };

        const { abort } = client.streamContainerLogs(
          container.containerId,
          {
            stdout: true,
            stderr: true,
            tail,
            follow: true,
            timestamps: true,
          },
          (line) => {
            // Each line is already processed by streamContainerLogs
            safeEnqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
          },
          () => {
            safeEnqueue(encoder.encode('data: [DONE]\n\n'));
            safeClose();
          },
          (err) => {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
            safeClose();
          }
        );

        abortFn = abort;
      },
      cancel() {
        controllerClosed = true;
        if (abortFn) {
          abortFn();
        }
        client.destroy();
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } else {
    // One-time fetch for historical logs
    try {
      const logs = await client.getContainerLogs(container.containerId, {
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      });
      
      client.destroy();
      
      return new Response(logs, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (error: any) {
      console.error('Logs error:', {
        message: error.message,
        code: error.code,
      });
      client.destroy();
      return json({ error: error.message, code: error.code }, { status: 500 });
    }
  }
}
