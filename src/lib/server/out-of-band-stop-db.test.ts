import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { desiredState, diff, toObserved } from './reconcile';
import { evictPodmanClient } from './podman-client';
import { OUT_OF_BAND_STOP_SETTLE_MS, synchronizeWorkerRuntimePolicies } from './runtime-policy';

// A container stopped on the worker itself — `podman stop`, Cockpit — rather
// than through Rudder. Podman's StoppedByUser is what tells that from a crash.
const workerId = 'oob-stop-worker';
const appId = 'oob-stop-app';
const rowId = 'oob-stop-row';
const containerId = 'oobstop0';
let server: ReturnType<typeof Bun.serve>;
const markers = new Map<string, string>();
const helpers = new Map<string, { id: string; intent: string }>();
const stopStateCalls: string[] = [];
/** What libpod's inspect reports; `null` answers 404, as a worker without the route would. */
let stopState: { Status: string; StoppedByUser: boolean; FinishedAt: string } | null;

function row() {
  return db.select().from(containers).where(eq(containers.id, rowId)).get()!;
}
function worker() {
  return db.select().from(workers).where(eq(workers.id, workerId)).get()!;
}
function report() {
  const app = db.select().from(applications).where(eq(applications.id, appId)).get()!;
  const records = [row()];
  return diff({
    desired: [desiredState({ app, worker: worker() })],
    rows: records,
    observed: records.map((r) => toObserved({
      Id: r.containerId, Names: [r.name], Image: r.image, State: 'exited', Status: 'exited', Labels: {},
    } as any)),
    knownAppIds: new Set([appId]),
  });
}
/** Run the sync at `minutes` after the first sighting, by the control plane's clock. */
const start = Date.now();
const syncAt = (minutes: number) => synchronizeWorkerRuntimePolicies(workerId, start + minutes * 60_000);

beforeAll(async () => {
  server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/images/create') return new Response('{"status":"done"}\n', { status: 200 });
    if (path.startsWith('/images/') && path.endsWith('/json')) return Response.json({ Id: 'sha256:test', RepoTags: [] });
    if (path === `/v4.0.0/libpod/containers/${containerId}/json`) {
      stopStateCalls.push(containerId);
      return stopState ? Response.json({ Id: containerId, State: stopState }) : new Response('not found', { status: 404 });
    }
    if (path === `/containers/${containerId}/json`) {
      return Response.json({ Id: containerId, Name: '/oob', State: { Running: false },
        Config: { Image: 'nginx:1.27', Labels: {} }, HostConfig: { RestartPolicy: { Name: 'always' } } });
    }
    if (path === '/containers/create') {
      const config = await request.json() as any;
      const id = `oobhelper${helpers.size}`;
      helpers.set(id, { id: config.Cmd[4], intent: config.Cmd[5] });
      return Response.json({ Id: id, Warnings: [] });
    }
    const helperCall = /^\/containers\/(oobhelper\d+)(?:\/(start|wait))?$/.exec(path);
    if (helperCall) {
      const helper = helpers.get(helperCall[1])!;
      if (helperCall[2] === 'wait') {
        markers.set(helper.id, helper.intent);
        return Response.json({ StatusCode: 0 });
      }
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected Podman call', { status: 500 });
  } });
  const now = new Date();
  await db.insert(workers).values({ id: workerId, name: workerId, hostname: 'localhost', sshUser: 'root',
    podmanApiUrl: `http://localhost:${server.port}`, status: 'online', createdAt: now });
  await db.insert(applications).values({ id: appId, workerId, name: 'oob-stop',
    manifest: 'nginx:1.27', createdAt: now, updatedAt: now });
  const want = desiredState({ app: db.select().from(applications).where(eq(applications.id, appId)).get()!, worker: worker() })
    .containers[0];
  await db.insert(containers).values({ id: rowId, applicationId: appId, workerId, containerId,
    name: want.name, image: 'nginx:1.27', status: 'exited', specHash: want.specHash, createdAt: now, updatedAt: now });
});

beforeEach(() => {
  db.update(containers).set({ desiredStatus: null, state: 'active', status: 'exited' }).where(eq(containers.id, rowId)).run();
  db.update(applications).set({ desiredStatus: 'running' }).where(eq(applications.id, appId)).run();
  db.update(workers).set({ routingRevision: 0, configAppliedHash: 'acknowledged' }).where(eq(workers.id, workerId)).run();
  stopStateCalls.length = 0;
  // Each test starts from a sighting the module has never seen before.
  stopState = { Status: 'exited', StoppedByUser: true, FinishedAt: `2026-10-03T12:00:00.${Math.random()}Z` };
});

afterAll(() => { evictPodmanClient(workerId); server.stop(true); });

describe('stops made outside Rudder', () => {
  test('are recorded as intent once they have held for the settle period', async () => {
    expect(report().drift.map((d) => d.kind)).toEqual(['missing']);
    expect((await syncAt(0)).adoptedStops).toBe(0);
    expect((await syncAt(OUT_OF_BAND_STOP_SETTLE_MS / 60_000 - 1)).adoptedStops).toBe(0);
    expect(row().desiredStatus).toBeNull();
    expect(markers.get(containerId)).toBe('running');

    const result = await syncAt(OUT_OF_BAND_STOP_SETTLE_MS / 60_000);
    expect(result).toMatchObject({ adoptedStops: 1, failures: [] });
    expect(row().desiredStatus).toBe('stopped');
    // Routing changes with it, exactly as for a Stop pressed in Rudder.
    expect(worker()).toMatchObject({ routingRevision: 1, configAppliedHash: null });
    expect(markers.get(containerId)).toBe('stopped');
    expect(report().clean).toBe(true);
  });

  test('a container that exited by itself is never taken for a decision', async () => {
    stopState = { ...stopState!, StoppedByUser: false };
    for (const minutes of [0, 10, 60]) expect((await syncAt(minutes)).adoptedStops).toBe(0);
    expect(row().desiredStatus).toBeNull();
    expect(worker().routingRevision).toBe(0);
  });

  test('a stop that is started and stopped again starts the clock over', async () => {
    await syncAt(0);
    stopState = { ...stopState!, FinishedAt: `${stopState!.FinishedAt}-again` };
    expect((await syncAt(OUT_OF_BAND_STOP_SETTLE_MS / 60_000)).adoptedStops).toBe(0);
    expect((await syncAt(2 * OUT_OF_BAND_STOP_SETTLE_MS / 60_000)).adoptedStops).toBe(1);
  });

  test('a sighting interrupted by the container running again is forgotten', async () => {
    await syncAt(0);
    db.update(containers).set({ status: 'running' }).where(eq(containers.id, rowId)).run();
    await syncAt(1);
    db.update(containers).set({ status: 'exited' }).where(eq(containers.id, rowId)).run();
    expect((await syncAt(OUT_OF_BAND_STOP_SETTLE_MS / 60_000)).adoptedStops).toBe(0);
  });

  test('only an active container Rudder wants running is inspected', async () => {
    db.update(containers).set({ state: 'draining' }).where(eq(containers.id, rowId)).run();
    await syncAt(0);
    db.update(containers).set({ state: 'active' }).where(eq(containers.id, rowId)).run();
    db.update(applications).set({ desiredStatus: 'stopped' }).where(eq(applications.id, appId)).run();
    await syncAt(0);
    db.update(applications).set({ desiredStatus: 'running' }).where(eq(applications.id, appId)).run();
    db.update(containers).set({ status: 'running' }).where(eq(containers.id, rowId)).run();
    await syncAt(0);
    expect(stopStateCalls).toEqual([]);
  });

  test('a worker without the libpod route concludes nothing and reports no failure', async () => {
    stopState = null;
    for (const minutes of [0, 10]) expect(await syncAt(minutes)).toMatchObject({ adoptedStops: 0, failures: [] });
    expect(row().desiredStatus).toBeNull();
  });
});
