import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import type { PodmanClient } from './podman';
import { withPodman } from './podman-client';
import { withLock, workerDeployLock } from './locks';
import { env } from './env';
import bootScript from './provisioning/shell/scripts/rudder-container-boot.sh?raw';

type RuntimeRow = Pick<typeof containers.$inferSelect, 'id' | 'containerId'>;
type PolicyClient = Pick<PodmanClient, 'getContainer' | 'createContainer' | 'startContainer' | 'waitContainer' | 'removeContainer'>;
export const RUNTIME_INTENT_DIRECTORY = '/var/lib/rudder/runtime-intent';
const persisted = new Map<string, 'running' | 'stopped'>();

/** Fixed host paths and a base64 source payload keep shell input independent of callers. */
export function runtimeIntentHelperCommand(id: string, intent: 'running' | 'stopped'): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid container identity');
  const source = Buffer.from(bootScript).toString('base64');
  return ['sh', '-c',
    'set -eu; tmp=; guard=$(mktemp /rudder-host-bin/.rudder-boot.XXXXXX); ' +
    'trap \'rm -f "$guard" "$tmp"\' EXIT; ' +
    `printf '%s' '${source}' | base64 -d > "$guard"; chmod 755 "$guard"; sync; ` +
    'mv -f "$guard" /rudder-host-bin/rudder-container-boot.sh; sync; ' +
    'intent=/rudder-var-lib/rudder/runtime-intent; mkdir -p "$intent"; tmp=$(mktemp "$intent/.next.XXXXXX"); ' +
    'printf "%s\\n" "$2" > "$tmp"; chmod 600 "$tmp"; sync; mv -f "$tmp" "$intent/$1"; sync',
    'rudder-runtime-intent', id, intent];
}

/** Call under the worker lock. A successful helper exit confirms the durable write. */
async function persistWorkerIntent(client: PolicyClient, row: RuntimeRow, intent: 'running' | 'stopped'): Promise<void> {
  const fresh = db.select().from(containers).where(and(eq(containers.id, row.id), eq(containers.containerId, row.containerId))).get();
  if (!fresh) throw new Error('Container identity changed before persisting worker runtime intent');
  const cacheKey = `${fresh.workerId}:${row.containerId}`;
  if (persisted.get(cacheKey) === intent) return;
  const inspect = await client.getContainer(row.containerId);
  const id = inspect.Id;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Worker returned an invalid container identity');
  // Podman 4.9 cannot update restart policy. An independent boot marker works
  // with existing workers while preserving conmon's original crash policy.
  const helper = await client.createContainer({
    name: `rudder-runtime-intent-${crypto.randomUUID().slice(0, 12)}`,
    image: env.VOLUME_TOOL_IMAGE,
    restartPolicy: 'no',
    // /var/lib exists on supported workers; Podman requires bind sources to
    // exist, so the helper creates our narrower directory inside that mount.
    binds: ['/var/lib:/rudder-var-lib:rw', '/usr/local/bin:/rudder-host-bin:rw'],
    labels: { 'rudder.managed': 'true', 'rudder.role': 'volume-helper' },
    command: runtimeIntentHelperCommand(id, intent),
  });
  try {
    await client.startContainer(helper.Id);
    const exitCode = await client.waitContainer(helper.Id);
    if (exitCode !== 0) throw new Error(`Worker could not persist runtime intent (helper exit ${exitCode})`);
    persisted.set(cacheKey, intent);
  } finally {
    try { await client.removeContainer(helper.Id, true); }
    catch (error) { console.warn('[runtime-policy] Could not remove runtime intent helper:', (error as Error).message); }
  }
}

export async function suppressContainerRestart(client: PolicyClient, row: RuntimeRow): Promise<void> {
  await persistWorkerIntent(client, row, 'stopped');
}

export async function restoreContainerRestart(client: PolicyClient, row: RuntimeRow): Promise<void> {
  await persistWorkerIntent(client, row, 'running');
}

/** Populate older rows and retry failed writes when the worker becomes reachable. */
export async function synchronizeWorkerRuntimePolicies(workerId: string): Promise<{
  synchronized: number; failures: { containerId: string; message: string }[];
}> {
  return withLock(workerDeployLock(workerId), { operation: 'synchronize runtime policies', holder: crypto.randomUUID() }, async () => {
    const worker = db.select().from(workers).where(eq(workers.id, workerId)).get();
    const result = { synchronized: 0, failures: [] as { containerId: string; message: string }[] };
    if (!worker) return result;
    const rows = db.select({ container: containers, app: applications }).from(containers)
      .leftJoin(applications, eq(containers.applicationId, applications.id))
      .where(eq(containers.workerId, workerId)).all();
    const trackedKeys = new Set(rows.map(({ container }) => `${workerId}:${container.containerId}`));
    for (const key of persisted.keys()) {
      if (key.startsWith(`${workerId}:`) && !trackedKeys.has(key)) persisted.delete(key);
    }
    await withPodman(worker, async (client) => {
      for (const { container, app } of rows) {
        try {
          if (container.state !== 'active' || (container.desiredStatus ?? app?.desiredStatus ?? 'running') === 'stopped') {
            await suppressContainerRestart(client, container);
          } else await restoreContainerRestart(client, container);
          result.synchronized++;
        } catch (error) {
          result.failures.push({ containerId: container.containerId, message: (error as Error).message });
        }
      }
    });
    return result;
  });
}
