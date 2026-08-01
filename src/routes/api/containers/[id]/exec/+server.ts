import { json } from '@sveltejs/kit';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { authErrorResponse, requireContainerAccess } from '$lib/server/auth';

export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  let container, worker;
  try {
    ({ container, worker } = await requireContainerAccess(cookies, params.id));
  } catch (error) {
    return authErrorResponse(error);
  }

  const { command } = await request.json();

  if (!command) {
    return json({ error: 'Command required' }, { status: 400 });
  }

  let client: ReturnType<typeof getRestPodmanClient>;
  try {
    client = getRestPodmanClient(worker);
  } catch (e: any) {
    return json({ error: `Client creation failed: ${e.message}` }, { status: 400 });
  }

  try {
    // Parse command into arguments array
    const cmdParts = command.trim().split(/\s+/);
    
    // Use HTTP exec - run command directly without shell wrapper
    const result = await client.execContainerHttp(
      container.containerId,
      cmdParts
    );
    
    client.destroy();
    
    return json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  } catch (error: any) {
    console.error('Exec error:', {
      message: error.message,
      code: error.code,
    });
    client.destroy();
    return json({ error: error.message, code: error.code }, { status: 500 });
  }
}

// Handle WebSocket upgrade for interactive terminal
export async function GET({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  let worker;
  try {
    ({ worker } = await requireContainerAccess(cookies, params.id));
  } catch (error) {
    return authErrorResponse(error);
  }

  // Check if this is a WebSocket upgrade request
  const upgradeHeader = request.headers.get('upgrade');
  if (upgradeHeader !== 'websocket') {
    return json({ error: 'WebSocket upgrade required' }, { status: 400 });
  }

  try {
    getRestPodmanClient(worker).destroy();
  } catch (e: any) {
    return json({ error: `Client creation failed: ${e.message}` }, { status: 400 });
  }

  // Return 101 Switching Protocols - actual WebSocket handling will be done by SvelteKit
  return new Response(null, {
    status: 101,
    headers: {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
    },
  });
}
