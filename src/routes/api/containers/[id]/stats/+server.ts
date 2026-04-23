import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbContainer = await db
    .select()
    .from(containers)
    .where(eq(containers.id, params.id))
    .get();

  if (!dbContainer || !dbContainer.workerId) {
    return json({ error: 'Container not found' }, { status: 404 });
  }

  const worker = await db
    .select()
    .from(workers)
    .where(eq(workers.id, dbContainer.workerId))
    .get();

  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    const client = getRestPodmanClient(worker);
    const raw = await client.getContainerStats(dbContainer.containerId);
    client.destroy();

    // Compute CPU percentage
    const cpuDelta =
      raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    const numCpus =
      raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
    const cpuPercent =
      systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    // Memory
    const memUsage = raw.memory_stats.usage ?? 0;
    const memLimit = raw.memory_stats.limit ?? 0;
    const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

    // Network I/O — sum all interfaces
    let rxBytes = 0;
    let txBytes = 0;
    if (raw.networks) {
      for (const iface of Object.values(raw.networks)) {
        rxBytes += iface.rx_bytes ?? 0;
        txBytes += iface.tx_bytes ?? 0;
      }
    }

    // Block I/O
    let blockRead = 0;
    let blockWrite = 0;
    if (raw.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of raw.blkio_stats.io_service_bytes_recursive) {
        if (entry.op === 'Read') blockRead += entry.value;
        if (entry.op === 'Write') blockWrite += entry.value;
      }
    }

    return json({
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memUsageBytes: memUsage,
      memLimitBytes: memLimit,
      memPercent: Math.round(memPercent * 100) / 100,
      netRxBytes: rxBytes,
      netTxBytes: txBytes,
      blockReadBytes: blockRead,
      blockWriteBytes: blockWrite,
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error('Stats error:', error);
    return json({ error: error.message }, { status: 500 });
  }
}
