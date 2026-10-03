import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { PodmanClient } from './podman';
import { withPodman } from './podman-client';
import { withLock, workerDeployLock } from './locks';
import { env } from './env';
import bootScript from './provisioning/shell/scripts/rudder-container-boot.sh?raw';

type RuntimeRow = Pick<typeof containers.$inferSelect, 'id' | 'containerId'>;
type PolicyClient = Pick<PodmanClient, 'getContainer' | 'createContainer' | 'startContainer' | 'waitContainer' | 'removeContainer'>;
type SyncClient = PolicyClient & Pick<PodmanClient, 'getContainerStopState'>;
export const RUNTIME_INTENT_DIRECTORY = '/var/lib/rudder/runtime-intent';
const persisted = new Map<string, 'running' | 'stopped'>();

/**
 * How long a stop made outside Rudder must hold before it is taken as a
 * decision. The boot unit stops every application with `podman stop` on the way
 * down, which sets the same flag a person's `podman stop` does, and the API
 * keeps answering for a moment after. A host that really is shutting down is
 * unreachable or rebooted — and a reboot clears the flag — well within this.
 */
export const OUT_OF_BAND_STOP_SETTLE_MS = 5 * 60_000;
/** First sighting of each candidate, by this process's clock — never the worker's. */
const outOfBandStops = new Map<string, { finishedAt: string; firstSeen: number }>();

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

/**
 * Adopt a stop made on the worker itself — `podman stop`, Cockpit — as intent.
 *
 * Without this the container stays desired-running: it is reported as drift,
 * and the next boot or provisioning starts it again. Only an `active` row Rudder
 * wants running qualifies, and only once Podman says a person stopped it and it
 * has stayed that way for the settle period. Every stop Rudder makes itself
 * either records intent first or targets a generation that is not `active`, and
 * a crash leaves the flag false. Call under the worker lock: the recording must
 * not interleave with an operation that is about to start the container.
 */
async function adoptOutOfBandStop(
  client: SyncClient,
  workerId: string,
  container: typeof containers.$inferSelect,
  now: number,
): Promise<boolean> {
  const key = `${workerId}:${container.containerId}`;
  const state = await client.getContainerStopState(container.containerId);
  if (!state || state.status !== 'exited' || !state.stoppedByUser) {
    outOfBandStops.delete(key);
    return false;
  }
  const seen = outOfBandStops.get(key);
  // A different FinishedAt is a different stop: started and stopped again since.
  if (!seen || seen.finishedAt !== state.finishedAt) {
    outOfBandStops.set(key, { finishedAt: state.finishedAt, firstSeen: now });
    return false;
  }
  if (now - seen.firstSeen < OUT_OF_BAND_STOP_SETTLE_MS) return false;
  outOfBandStops.delete(key);
  // Same statements as a Stop from the container page.
  db.transaction((tx) => {
    tx.update(containers).set({ desiredStatus: 'stopped' })
      .where(and(eq(containers.id, container.id), eq(containers.containerId, container.containerId))).run();
    tx.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
  });
  console.info(`[runtime-policy] ${container.name} was stopped on the worker, outside Rudder; recorded as stopped.`);
  return true;
}

/** Populate older rows and retry failed writes when the worker becomes reachable. */
export async function synchronizeWorkerRuntimePolicies(workerId: string, now: number = Date.now()): Promise<{
  synchronized: number; adoptedStops: number; failures: { containerId: string; message: string }[];
}> {
  return withLock(workerDeployLock(workerId), { operation: 'synchronize runtime policies', holder: crypto.randomUUID() }, async () => {
    const worker = db.select().from(workers).where(eq(workers.id, workerId)).get();
    const result = { synchronized: 0, adoptedStops: 0, failures: [] as { containerId: string; message: string }[] };
    if (!worker) return result;
    const rows = db.select({ container: containers, app: applications }).from(containers)
      .leftJoin(applications, eq(containers.applicationId, applications.id))
      .where(eq(containers.workerId, workerId)).all();
    const trackedKeys = new Set(rows.map(({ container }) => `${workerId}:${container.containerId}`));
    for (const cache of [persisted, outOfBandStops]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${workerId}:`) && !trackedKeys.has(key)) cache.delete(key);
      }
    }
    await withPodman(worker, async (client) => {
      for (const { container, app } of rows) {
        const wanted = container.desiredStatus ?? app?.desiredStatus ?? 'running';
        // `status` is the last sweep's reading, so a running container costs no request.
        if (container.state !== 'active' || wanted !== 'running' || container.status === 'running') {
          outOfBandStops.delete(`${workerId}:${container.containerId}`);
          continue;
        }
        try {
          if (await adoptOutOfBandStop(client, workerId, container, now)) {
            container.desiredStatus = 'stopped';
            result.adoptedStops++;
          }
        } catch (error) {
          result.failures.push({ containerId: container.containerId, message: (error as Error).message });
        }
      }
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
