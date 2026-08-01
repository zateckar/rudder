import { json } from '@sveltejs/kit';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { authErrorResponse, requireContainerAccess } from '$lib/server/auth';

export async function GET({ url, cookies }: { url: URL; cookies: any }) {
  const containerIdParam = url.searchParams.get('containerId');
  const tail = parseInt(url.searchParams.get('tail') || '1000');
  const follow = url.searchParams.get('follow') === 'true';

  if (!containerIdParam) {
    return json({ error: 'Container ID required' }, { status: 400 });
  }

  let container, worker;
  try {
    ({ container, worker } = await requireContainerAccess(cookies, containerIdParam));
  } catch (error) {
    return authErrorResponse(error);
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
