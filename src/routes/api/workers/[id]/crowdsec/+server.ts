import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const tailLines = parseInt(url.searchParams.get('tail') || '100');

  try {
    let crowdsecInspect: any = null;
    let crowdsecStatus = 'not_found';
    let crowdsecLogs = '';
    let bouncerKey: string | null = worker.crowdsecBouncerKey || null;
    let decisions: string = '';
    let appsecStatus: string = '';

    // Try to find crowdsec container via REST API
    if (worker.podmanApiUrl) {
      const client = getRestPodmanClient(worker);
      try {
        const allContainers = await client.listContainers(true);
        const csC = allContainers.find((c: any) =>
          c.Names?.includes('/crowdsec') || c.Names?.some((n: string) => n.includes('crowdsec'))
        );

        if (csC) {
          crowdsecStatus = csC.State || 'unknown';
          try { crowdsecInspect = await client.getContainer(csC.Id); } catch {}
          try { crowdsecLogs = await client.getContainerLogs(csC.Id, { stdout: true, stderr: true, tail: tailLines }); } catch {}
        }
      } catch {}
      client.destroy();
    }


    // Parse decisions if we got valid JSON
    let parsedDecisions: any[] = [];
    if (decisions && decisions !== '[]') {
      try {
        parsedDecisions = JSON.parse(decisions);
        if (!Array.isArray(parsedDecisions)) parsedDecisions = [];
      } catch { parsedDecisions = []; }
    }

    return json({
      status: crowdsecStatus,
      inspect: crowdsecInspect,
      logs: crowdsecLogs,
      bouncerKey,
      decisions: parsedDecisions,
      appsecStatus,
    });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
