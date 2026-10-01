import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { applications, containers, reconcileReports, workers, workerMetrics, workerPings } from '$lib/db/schema';
import { isLocked, LockError, withLock, workerDeployLock, workerMutationEpoch, workerSnapshotIsCurrent } from './locks';
import { persistContainerObservations, persistSweep, sweepWorker } from './metrics';
import { desiredState, diff, reconcileWorker, StaleWorkerSnapshotError, toObserved } from './reconcile';
import { evictPodmanClient } from './podman-client';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('worker callback lifetime', () => {
  test('a callback remains exclusive past its TTL, including identical holder names', async () => {
    const workerId = 'lifetime-freshness';
    const key = workerDeployLock(workerId);
    const epoch = workerMutationEpoch(workerId);
    const gate = barrier();
    const held = withLock(key, { operation: 'slow deploy', holder: 'same-holder', ttlMs: 1 }, async () => gate.promise);
    await Bun.sleep(5);
    expect(isLocked(key)).toBe(true);
    expect(workerMutationEpoch(workerId)).toBe(epoch + 1);
    expect(workerSnapshotIsCurrent(workerId, epoch + 1)).toBe(false);
    await expect(withLock(key, { operation: 'stop', holder: 'same-holder' }, async () => {})).rejects.toBeInstanceOf(LockError);
    gate.release();
    await held;
    expect(isLocked(key)).toBe(false);
    expect(workerMutationEpoch(workerId)).toBe(epoch + 2);
    expect(workerSnapshotIsCurrent(workerId, epoch)).toBe(false);
    expect(workerSnapshotIsCurrent(workerId, epoch + 2)).toBe(true);
  });

  test('a failed callback still releases ownership and invalidates previous reads', async () => {
    const workerId = 'lifetime-error';
    const epoch = workerMutationEpoch(workerId);
    await expect(withLock(workerDeployLock(workerId), { operation: 'failing stop' }, async () => {
      throw new Error('remote failure');
    })).rejects.toThrow('remote failure');
    expect(isLocked(workerDeployLock(workerId))).toBe(false);
    expect(workerMutationEpoch(workerId)).toBe(epoch + 2);
  });
});

const workerId = 'freshness-db-worker';
const appId = 'freshness-db-app';
const rowId = 'freshness-db-row';
const originalTimestamp = new Date(1_600_000_000_000);
let server: ReturnType<typeof Bun.serve>;
let listingStarted = barrier();
let finishListing = barrier();
let listingState = 'exited';

const workerRow = () => db.select().from(workers).where(eq(workers.id, workerId)).get()!;
const containerRow = () => db.select().from(containers).where(eq(containers.id, rowId)).get()!;

beforeAll(async () => {
  server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/_ping') return new Response('OK');
    if (path === '/info') return Response.json({ host: {}, store: {} });
    if (path.endsWith('/system/df')) return Response.json({});
    if (path.endsWith('/stats')) return Response.json({});
    if (path === '/containers/json') {
      const state = listingState;
      listingStarted.release();
      await finishListing.promise;
      return Response.json([{ Id: 'original', Names: ['freshness'], State: state, Labels: {} }]);
    }
    return new Response('unexpected request', { status: 500 });
  } });
  db.insert(workers).values({ id: workerId, name: workerId, hostname: 'localhost', sshUser: 'root',
    podmanApiUrl: `http://localhost:${server.port}`, status: 'online', createdAt: originalTimestamp }).run();
  db.insert(applications).values({ id: appId, workerId, name: 'freshness', manifest: 'nginx:1.27',
    createdAt: originalTimestamp, updatedAt: originalTimestamp }).run();
  const app = db.select().from(applications).where(eq(applications.id, appId)).get()!;
  const want = desiredState({ app, worker: workerRow() }).containers[0];
  db.insert(containers).values({ id: rowId, workerId, applicationId: appId, containerId: 'original',
    name: want.name, image: 'nginx:1.27', specHash: want.specHash, status: 'running',
    createdAt: originalTimestamp, updatedAt: originalTimestamp }).run();
});

afterAll(() => {
  finishListing.release();
  evictPodmanClient(workerId);
  server.stop(true);
  db.delete(reconcileReports).where(eq(reconcileReports.workerId, workerId)).run();
  db.delete(workerMetrics).where(eq(workerMetrics.workerId, workerId)).run();
  db.delete(workerPings).where(eq(workerPings.workerId, workerId)).run();
  db.delete(containers).where(eq(containers.id, rowId)).run();
  db.delete(applications).where(eq(applications.id, appId)).run();
  db.delete(workers).where(eq(workers.id, workerId)).run();
});

describe('observation freshness', () => {
  test('a delayed real metrics sweep cannot overwrite a recreated row', async () => {
    listingStarted = barrier();
    finishListing = barrier();
    const epoch = workerMutationEpoch(workerId);
    const sweep = sweepWorker(workerRow(), [containerRow()], epoch);
    await listingStarted.promise;
    await withLock(workerDeployLock(workerId), { operation: 'recreate' }, async () => {
      db.update(containers).set({ containerId: 'replacement', status: 'running' }).where(eq(containers.id, rowId)).run();
    });
    finishListing.release();
    await persistSweep(await sweep, new Date());
    expect(containerRow().containerId).toBe('replacement');
    expect(containerRow().status).toBe('running');
    db.update(containers).set({ containerId: 'original' }).where(eq(containers.id, rowId)).run();
  });

  test('a delayed real metrics sweep cannot overwrite a same-ID lifecycle stop', async () => {
    db.update(containers).set({ status: 'exited' }).where(eq(containers.id, rowId)).run();
    listingState = 'running';
    listingStarted = barrier();
    finishListing = barrier();
    const epoch = workerMutationEpoch(workerId);
    const sweep = sweepWorker(workerRow(), [containerRow()], epoch);
    await listingStarted.promise;
    await withLock(workerDeployLock(workerId), { operation: 'stop' }, async () => {
      db.update(containers).set({ status: 'exited', desiredStatus: 'stopped' }).where(eq(containers.id, rowId)).run();
    });
    finishListing.release();
    await persistSweep(await sweep, new Date());
    expect(containerRow().status).toBe('exited');
    listingState = 'exited';
  });

  test('an old observation cannot overwrite a stop of the same Podman container', async () => {
    const epoch = workerMutationEpoch(workerId);
    await withLock(workerDeployLock(workerId), { operation: 'stop' }, async () => {
      db.update(containers).set({ status: 'exited', desiredStatus: 'stopped' }).where(eq(containers.id, rowId)).run();
    });
    expect(persistContainerObservations(workerId, epoch, new Map([
      ['running', [{ id: rowId, containerId: 'original' }]],
    ]))).toBe(false);
    expect(containerRow().status).toBe('exited');
  });

  test('a replacement Podman ID rejects observations for the previous identity', () => {
    const epoch = workerMutationEpoch(workerId);
    db.update(containers).set({ containerId: 'replacement', status: 'running' }).where(eq(containers.id, rowId)).run();
    expect(persistContainerObservations(workerId, epoch, new Map([
      ['exited', [{ id: rowId, containerId: 'original' }]],
    ]))).toBe(true);
    expect(containerRow().status).toBe('running');
  });

  test('a current observation updates status without extending retention time', () => {
    const epoch = workerMutationEpoch(workerId);
    const revision = workerRow().routingRevision;
    db.update(workers).set({ configAppliedHash: 'previously-installed-body' }).where(eq(workers.id, workerId)).run();
    expect(persistContainerObservations(workerId, epoch, new Map([
      ['exited', [{ id: rowId, containerId: 'replacement' }]],
    ]))).toBe(true);
    expect(containerRow().status).toBe('exited');
    expect(containerRow().updatedAt).toEqual(originalTimestamp);
    expect(workerRow().routingRevision).toBeGreaterThan(revision);
    expect(workerRow().configAppliedHash).toBeNull();
  });

  test('reconciliation discards a report assembled across a completed stop', async () => {
    db.update(applications).set({ desiredStatus: 'running' }).where(eq(applications.id, appId)).run();
    db.update(containers).set({ containerId: 'original', status: 'running', desiredStatus: null }).where(eq(containers.id, rowId)).run();
    listingStarted = barrier();
    finishListing = barrier();
    const pass = reconcileWorker(workerRow()).then(() => null, (error: unknown) => error);
    await listingStarted.promise;
    await withLock(workerDeployLock(workerId), { operation: 'manual stop' }, async () => {
      db.update(applications).set({ desiredStatus: 'stopped' }).where(eq(applications.id, appId)).run();
      db.update(containers).set({ status: 'exited' }).where(eq(containers.id, rowId)).run();
    });
    finishListing.release();
    expect(await pass).toBeInstanceOf(StaleWorkerSnapshotError);
    expect(db.select().from(reconcileReports).where(eq(reconcileReports.workerId, workerId)).get()).toBeUndefined();
  });

  test('supplied observations require the matching mutation epoch', async () => {
    const observed = [toObserved({ Id: 'original', Names: [containerRow().name], State: 'exited', Labels: {} } as any)];
    const epoch = workerMutationEpoch(workerId);
    await expect(reconcileWorker(workerRow(), { observed })).rejects.toBeInstanceOf(StaleWorkerSnapshotError);
    await expect(reconcileWorker(workerRow(), { observed, observedEpoch: epoch - 1 })).rejects.toBeInstanceOf(StaleWorkerSnapshotError);
    const fresh = await reconcileWorker(workerRow(), { observed, observedEpoch: epoch });
    expect(fresh.clean).toBe(true);
    expect(fresh.correctable).toEqual([]);
  });

  test('an active mutation prevents publishing even an epoch-matched observation', async () => {
    await withLock(workerDeployLock(workerId), { operation: 'deploy' }, async () => {
      const previous = db.select().from(reconcileReports).where(eq(reconcileReports.workerId, workerId)).get();
      await expect(reconcileWorker(workerRow(), { observed: [], observedEpoch: workerMutationEpoch(workerId) }))
        .rejects.toBeInstanceOf(StaleWorkerSnapshotError);
      expect(db.select().from(reconcileReports).where(eq(reconcileReports.workerId, workerId)).get()).toEqual(previous);
    });
  });

  test('retention uses the dedicated cutover timestamp even after another lifecycle timestamp changes', () => {
    const now = new Date();
    const row = { ...containerRow(), state: 'draining' as const, retainedAt: originalTimestamp, updatedAt: now };
    const observed = [toObserved({ Id: row.containerId, Names: [row.name], State: 'exited', Labels: {} } as any)];
    const result = diff({ desired: [], rows: [row], observed, knownAppIds: new Set([appId]),
      apps: new Map([[appId, { name: 'freshness', retainPreviousMinutes: 30 }]]), now });
    expect(result.drift.map((entry) => entry.kind)).toEqual(['unreaped']);
  });
});
