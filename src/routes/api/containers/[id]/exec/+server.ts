import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { command } = await request.json();
  
  if (!command) {
    return json({ error: 'Command required' }, { status: 400 });
  }

  // Get container
  const container = await db.select().from(containers).where(eq(containers.id, params.id)).get();
  
  if (!container) {
    return json({ error: 'Container not found' }, { status: 404 });
  }

  if (!container.workerId) {
    return json({ error: 'Container has no worker assigned' }, { status: 400 });
  }

  // Get worker
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
export async function GET({ params, request, cookies, url }: { params: { id: string }; request: Request; cookies: any; url: URL }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check if this is a WebSocket upgrade request
  const upgradeHeader = request.headers.get('upgrade');
  if (upgradeHeader !== 'websocket') {
    return json({ error: 'WebSocket upgrade required' }, { status: 400 });
  }

  // Get container
  const container = await db.select().from(containers).where(eq(containers.id, params.id)).get();
  
  if (!container) {
    return json({ error: 'Container not found' }, { status: 404 });
  }

  if (!container.workerId) {
    return json({ error: 'Container has no worker assigned' }, { status: 400 });
  }

  // Get worker
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

  // Return 101 Switching Protocols - actual WebSocket handling will be done by SvelteKit
  return new Response(null, {
    status: 101,
    headers: {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
    },
  });
}
