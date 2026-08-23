import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRestPodmanClient, withPodman } from '$lib/server/podman-client';
import { requireContainer, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  const { url } = event;
  const containerIdParam = url.searchParams.get('containerId');
  const tail = parseInt(url.searchParams.get('tail') || '1000');
  const follow = url.searchParams.get('follow') === 'true';

  if (!containerIdParam) {
    return json({ error: 'Container ID required' }, { status: 400 });
  }

  const { container, worker } = await requireContainer(event, containerIdParam);

  if (follow) {
    // Not `withPodman`: the client has to outlive this function — it is owned
    // by the stream and destroyed when the stream closes or is cancelled.
    const client = getRestPodmanClient(worker);
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
  }

  // One-time fetch for historical logs.
  const logs = await withPodman(worker, (client) =>
    client.getContainerLogs(container.containerId, {
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    }),
  );

  return new Response(logs, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache',
    },
  });
});
