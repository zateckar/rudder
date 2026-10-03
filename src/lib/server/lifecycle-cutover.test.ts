import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, sqlite } from '$lib/db';
import { applications, containers, deployments, workers } from '$lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import { commitGenerationCutover, revertGenerationCutover, revertRetainedGenerationCutover } from './lifecycle-cutover';
import { executeApplicationDeploy, executeFastRollback, sweepExpiredGenerations, sweepInterruptedGenerations } from './deploy';
import { withLock, workerDeployLock } from './locks';
import { recoverInterruptedDeploymentHistory } from './recover';
import { expectedRoutingHash } from './routing-convergence';

const workerId = crypto.randomUUID();
const appId = crypto.randomUUID();
const oldId = crypto.randomUUID();
const nextId = crypto.randomUUID();
const deployId = crypto.randomUUID();
const removed: string[] = [];
const started: string[] = [];
const server = Bun.serve({ port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/networks/create') return Response.json({ Id: 'test-network' });
  if (path === '/images/create') return new Response('{"status":"done"}\n');
  if (path.startsWith('/images/') && path.endsWith('/json')) return Response.json({ Id: 'sha256:test' });
  if (path === '/containers/create') return Response.json({ Id: 'bare-created-runtime', Warnings: [] });
  if (path.endsWith('/logs')) return new Response('');
  if (path.endsWith('/start')) { started.push(path); return new Response(null, { status: 204 }); }
  if (request.method === 'DELETE') {
    removed.push(new URL(request.url).pathname);
    return new Response(null, { status: 204 });
  }
  return new Response('unexpected request', { status: 500 });
} });
afterAll(() => server.stop(true));

beforeEach(() => {
  sqlite.run('DROP TRIGGER IF EXISTS lifecycle_abort_promotion');
  sqlite.run('DROP TRIGGER IF EXISTS lifecycle_abort_container_insert');
  db.delete(containers).where(eq(containers.applicationId, appId)).run();
  db.delete(deployments).where(eq(deployments.applicationId, appId)).run();
  db.delete(applications).where(eq(applications.id, appId)).run();
  db.delete(workers).where(eq(workers.id, workerId)).run();
  const now = new Date();
  db.insert(workers).values({ id: workerId, name: 'lifecycle', hostname: 'lifecycle.example.com', sshUser: 'root',
    podmanApiUrl: server.url.toString(), routingMode: 'labels', configAppliedHash: 'old-ack',
    createdAt: now }).run();
  db.insert(applications).values({ id: appId, workerId, name: 'lifecycle', type: 'compose',
    manifest: 'services:\n  web:\n    image: nginx:1.27', retainPreviousMinutes: 1, createdAt: now, updatedAt: now }).run();
  db.insert(deployments).values({ id: deployId, applicationId: appId, version: 2, status: 'pending', createdAt: now }).run();
  db.insert(containers).values([
    { id: oldId, applicationId: appId, workerId, containerId: 'old-runtime', name: 'old', image: 'nginx',
      status: 'running', state: 'active', generation: 1, createdAt: now, updatedAt: now },
    { id: nextId, applicationId: appId, workerId, containerId: 'next-runtime', name: 'next', image: 'nginx',
      status: 'running', state: 'pending', generation: 2, deploymentId: deployId, createdAt: now, updatedAt: now },
  ]).run();
  db.update(workers).set({ configAppliedHash: 'old-ack' }).where(eq(workers.id, workerId)).run();
  removed.length = 0;
  started.length = 0;
});
const row = (id: string) => db.select().from(containers).where(eq(containers.id, id)).get()!;

describe('atomic lifecycle role transitions', () => {
  test('commits exclusive roles, recovery phase, retention clock and ACK invalidation together', () => {
    const before = db.select().from(workers).where(eq(workers.id, workerId)).get()!.routingRevision;
    commitGenerationCutover(workerId, [nextId], [oldId], deployId);
    expect(row(nextId).state).toBe('active');
    expect(row(oldId).state).toBe('draining');
    expect(row(oldId).retainedAt).toBeInstanceOf(Date);
    expect(row(nextId).retainedAt).toBeNull();
    expect(db.select().from(deployments).where(eq(deployments.id, deployId)).get()!.cutoverAt).toBeInstanceOf(Date);
    const worker = db.select().from(workers).where(eq(workers.id, workerId)).get()!;
    expect(worker.routingRevision).toBeGreaterThan(before);
    expect(worker.configAppliedHash).toBeNull();
  });

  test('SQL failure between role writes rolls back every write', () => {
    // A failure after demotion but before promotion has the same transaction
    // boundary as a crash: no partially committed roles/recovery metadata.
    sqlite.run(`CREATE TRIGGER lifecycle_abort_promotion BEFORE UPDATE OF state ON containers
      WHEN NEW.id = '${nextId}' AND NEW.state = 'active'
      BEGIN SELECT RAISE(ABORT, 'injected promotion failure'); END`);
    expect(() => commitGenerationCutover(workerId, [nextId], [oldId], deployId)).toThrow('injected');
    expect(row(oldId).state).toBe('active');
    expect(row(nextId).state).toBe('pending');
    expect(db.select().from(deployments).where(eq(deployments.id, deployId)).get()!.cutoverAt).toBeNull();
    expect(db.select().from(workers).where(eq(workers.id, workerId)).get()!.configAppliedHash).toBe('old-ack');
  });

  test('failed ACK restores only the previous active generation and retains candidate', () => {
    commitGenerationCutover(workerId, [nextId], [oldId], deployId);
    revertGenerationCutover(workerId, [oldId], [nextId], deployId);
    expect(row(oldId).state).toBe('active');
    expect(row(nextId).state).toBe('pending');
    expect(row(nextId).status).toBe('running');
    expect(removed).toEqual([]);
  });

  test('startup recovery distinguishes interrupted build from committed cutover', () => {
    commitGenerationCutover(workerId, [nextId], [oldId], deployId);
    recoverInterruptedDeploymentHistory();
    const history = db.select().from(deployments).where(eq(deployments.id, deployId)).get()!;
    expect(history.status).toBe('failed');
    expect(history.errorMessage).toContain('after committed cutover');
    expect(history.errorMessage).not.toContain('previous version continued');
    expect(row(oldId).state).toBe('draining');
    expect(row(nextId).state).toBe('active');
  });

  test('running deployment history is recovered as an interrupted nonterminal state', () => {
    db.update(deployments).set({ status: 'running' }).where(eq(deployments.id, deployId)).run();
    recoverInterruptedDeploymentHistory();
    const history = db.select().from(deployments).where(eq(deployments.id, deployId)).get()!;
    expect(history.status).toBe('failed');
    expect(history.errorMessage).toContain('before a committed generation switch');
    expect(row(nextId).state).toBe('pending');
  });

  test('failed rollback preserves a manually stopped previous replica and candidate retention deadline', () => {
    const deadline = new Date(Math.floor((Date.now() - 20_000) / 1000) * 1000);
    db.update(containers).set({ desiredStatus: 'stopped', status: 'exited' }).where(eq(containers.id, oldId)).run();
    db.update(containers).set({ state: 'draining', retainedAt: deadline }).where(eq(containers.id, nextId)).run();
    const previous = row(oldId);
    const candidate = row(nextId);
    commitGenerationCutover(workerId, [nextId], [oldId], undefined, appId);
    revertRetainedGenerationCutover(workerId, appId, 'running', [previous], [candidate]);
    expect(row(oldId).state).toBe('active');
    expect(row(oldId).desiredStatus).toBe('stopped');
    expect(row(nextId).state).toBe('draining');
    expect(row(nextId).retainedAt).toEqual(deadline);
  });
});

describe('cleanup serialization and eligibility', () => {
  test('busy worker cannot be reaped and a promoted target is re-read on retry', async () => {
    const expired = new Date(Date.now() - 120_000);
    db.update(containers).set({ state: 'draining', retainedAt: expired }).where(eq(containers.id, oldId)).run();
    await withLock(workerDeployLock(workerId), { operation: 'rollback' }, async () => {
      expect((await sweepExpiredGenerations()).removedContainerIds).not.toContain('old-runtime');
      commitGenerationCutover(workerId, [oldId], []);
    });
    expect((await sweepExpiredGenerations()).removedContainerIds).not.toContain('old-runtime');
    expect(row(oldId).state).toBe('active');
    expect(removed).toEqual([]);
  });

  test('retention uses demotion clock even when observed status was refreshed', async () => {
    db.update(containers).set({ state: 'draining', retainedAt: new Date(Date.now() - 120_000), updatedAt: new Date() })
      .where(eq(containers.id, oldId)).run();
    expect((await sweepExpiredGenerations()).removedContainerIds).toContain('old-runtime');
    expect(removed.some((path) => path.includes('old-runtime'))).toBe(true);
  });

  test('unacknowledged HTTP routing blocks draining and abandoned candidate deletion', async () => {
    db.update(workers).set({ routingMode: 'http', configAppliedHash: null }).where(eq(workers.id, workerId)).run();
    db.update(containers).set({ state: 'draining', retainedAt: new Date(Date.now() - 120_000) })
      .where(eq(containers.id, oldId)).run();
    db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, deployId)).run();
    expect((await sweepExpiredGenerations()).removedContainerIds).not.toContain('old-runtime');
    expect((await sweepInterruptedGenerations()).removedContainerIds).not.toContain('next-runtime');
    expect(removed).toEqual([]);
    expect(row(oldId)).toBeDefined();
    expect(row(nextId)).toBeDefined();
  });

  test('an expired rollback target is rejected before contacting the worker', async () => {
    db.update(workers).set({ routingMode: 'http' }).where(eq(workers.id, workerId)).run();
    db.update(containers).set({ state: 'draining', deploymentId: deployId, retainedAt: new Date(Date.now() - 120_000) })
      .where(eq(containers.id, oldId)).run();
    const result = await executeFastRollback(appId, deployId);
    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(result.statusCode).toBe(409);
    expect(removed).toEqual([]);
  });
});

describe('remote creation compensation', () => {
  for (const routingMode of ['labels', 'http'] as const) {
    test(`failed container insert compensates a bare remote create in ${routingMode} mode`, async () => {
      db.delete(containers).where(eq(containers.applicationId, appId)).run();
      db.update(workers).set({ routingMode, configFetchedAt: new Date() }).where(eq(workers.id, workerId)).run();
      // A worker that fetches but has not acknowledged the current routing is
      // refused before anything is created; this test is about what happens
      // after creation, so the worker has to be a converged one.
      db.update(workers).set({ configAppliedHash: await expectedRoutingHash(workerId) })
        .where(eq(workers.id, workerId)).run();
      sqlite.run(`CREATE TRIGGER lifecycle_abort_container_insert BEFORE INSERT ON containers
        WHEN NEW.application_id = '${appId}'
        BEGIN SELECT RAISE(ABORT, 'injected container insert failure'); END`);
      await expect(executeApplicationDeploy(appId)).rejects.toThrow('injected container insert failure');
      expect(removed.some((path) => path.includes('bare-created-runtime'))).toBe(true);
      expect(started).toEqual([]);
      expect(db.select().from(containers).where(eq(containers.applicationId, appId)).all()).toEqual([]);
      const history = db.select().from(deployments).where(eq(deployments.applicationId, appId))
        .orderBy(desc(deployments.version)).get()!;
      expect(history.status).toBe('failed');
    });
  }
});
