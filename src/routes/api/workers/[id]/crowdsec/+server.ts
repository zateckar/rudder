import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { getSSHKey } from '$lib/server/ssh';
import { createSSHPodmanClient } from '$lib/server/podman';

async function sshExec(sshClient: any, cmd: string): Promise<string> {
  try {
    const r = await sshClient['exec'](cmd);
    return r.exitCode === 0 ? r.stdout.trim() : '';
  } catch { return ''; }
}

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

    // Fallback: use SSH to find crowdsec and read logs
    if (worker.sshKeyId) {
      const sshKey = await getSSHKey(worker.sshKeyId);
      if (sshKey) {
        const sshClient = createSSHPodmanClient({
          host: worker.hostname,
          port: worker.sshPort,
          username: worker.sshUser,
          privateKey: sshKey.privateKey,
        });

        const psOut = await sshExec(sshClient, `podman ps -a --filter name=crowdsec --format '{{.ID}} {{.Status}} {{.State}}' 2>/dev/null`);
        if (psOut && crowdsecStatus === 'not_found') {
          const parts = psOut.split(/\s+/);
          crowdsecStatus = parts[2] || parts[1] || 'unknown';
        }

        if (!crowdsecLogs) {
          crowdsecLogs = await sshExec(sshClient, `podman logs --tail ${tailLines} crowdsec 2>&1`);
        }

        // Get current decisions from CrowdSec LAPI
        decisions = await sshExec(sshClient, `podman exec crowdsec cscli decisions list -o json 2>/dev/null || echo "[]"`);

        // Check AppSec status
        appsecStatus = await sshExec(sshClient, `podman exec crowdsec cscli appsec-rules list 2>/dev/null || echo "AppSec not available"`);

        sshClient.destroy();
      }
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
