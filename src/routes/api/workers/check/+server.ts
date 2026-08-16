import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export async function POST({ request, cookies, locals }: { request: Request; cookies: any; locals: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require admin role
  if (locals.userRole !== 'admin') {
    return json({ error: 'Forbidden - admin access required' }, { status: 403 });
  }

  const body = await request.json();
  const { workerId } = body;

  if (!workerId) {
    return json({ error: 'Worker ID required' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    let isOnline = false;

    // Try REST API first if credentials are available
    if (worker.podmanApiUrl) {
      try {
        const podmanClient = getRestPodmanClient(worker);
        isOnline = await podmanClient.ping();
        podmanClient.destroy();
      } catch (e) {
        console.warn('REST API check failed:', e);
      }
    }
    
    if (isOnline) {
      await db.update(workers)
        .set({ 
          status: 'online',
          lastSeenAt: new Date(),
        })
        .where(eq(workers.id, workerId));
    } else {
      await db.update(workers)
        .set({ status: 'offline' })
        .where(eq(workers.id, workerId));
    }
    
    return json({ online: isOnline });
  } catch (error: any) {
    console.error('Worker check error:', error);
    await db.update(workers)
      .set({ status: 'error' })
      .where(eq(workers.id, workerId));
    
    return json({ online: false, error: error.message }, { status: 500 });
  }
}
