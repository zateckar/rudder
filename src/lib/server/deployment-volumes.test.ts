import { afterEach, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, containers, teams, volumes, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { assertDeploymentVolumeAccess, type VolumeAccessSource } from './deployment-volumes';
import { desiredState } from './reconcile';
import { executeApplicationDeploy } from './deploy';
import { evictPodmanClient } from './podman-client';
import type { ContainerInspect } from './podman';
import type { DeploymentPlan } from './deploy/plan';

const cleanups: (() => PromiseLike<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const now = new Date();
  const owner = crypto.randomUUID();
  const otherTeam = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  for (const id of [owner, otherTeam]) {
    await db.insert(teams).values({ id, name: id, slug: id, createdAt: now, updatedAt: now });
    cleanups.push(() => db.delete(teams).where(eq(teams.id, id)));
  }
  await db.insert(workers).values({ id: workerId, name: workerId, hostname: 'worker.example.test', sshUser: 'root', sshPort: 22, podmanApiUrl: 'http://127.0.0.1:1', routingMode: 'labels', status: 'online', createdAt: now });
  cleanups.push(() => { evictPodmanClient(workerId); return db.delete(workers).where(eq(workers.id, workerId)); });
  const worker = (await db.select().from(workers).where(eq(workers.id, workerId)).get())!;
  async function app(teamId = owner, changes: Partial<typeof applications.$inferInsert> = {}) {
    const id = crypto.randomUUID();
    await db.insert(applications).values({ id, teamId, workerId, name: `app-${id}`, type: 'compose', manifest: 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - pgdata:/data\n', authType: 'none', createdAt: now, updatedAt: now, ...changes });
    cleanups.push(() => db.delete(applications).where(eq(applications.id, id)));
    return (await db.select().from(applications).where(eq(applications.id, id)).get())!;
  }
  async function mounted(a: typeof applications.$inferSelect, binds = ['pgdata:/data:rw']) {
    const id = crypto.randomUUID();
    await db.insert(containers).values({ id, applicationId: a.id, workerId, containerId: id, name: id, image: 'postgres:16', status: 'exited', createdAt: now, updatedAt: now });
    cleanups.push(() => db.delete(containers).where(eq(containers.id, id)));
    return { Id: id, Name: `/${id}`, Config: { Image: 'postgres:16', Labels: {} }, State: { Running: false, Status: 'exited', Pid: 0, ExitCode: 0 }, HostConfig: { Binds: binds }, NetworkSettings: { IPAddress: '' } } satisfies ContainerInspect;
  }
  function source(live: ContainerInspect[] = [], existing = ['pgdata']): VolumeAccessSource {
    return {
      listVolumes: async () => existing.map((name) => ({ name, labels: {}, mountpoint: null, createdAt: null })),
      listContainers: async () => live.map((c) => ({ Id: c.Id, Names: [c.Name] }) as any),
      getContainer: async (id) => live.find((c) => c.Id === id)!,
    };
  }
  function plan(a: typeof applications.$inferSelect): DeploymentPlan {
    const desired = desiredState({ app: a, worker });
    return { containers: desired.containers.map((c) => c.planned), notes: desired.notes };
  }
  return { owner, otherTeam, worker, app, mounted, source, plan };
}

describe('deployment volume authorization', () => {
  test('blocks another team declaration even before the volume exists', async () => {
    const f = await fixture();
    const a = await f.app();
    await f.app(f.otherTeam);
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []))).rejects.toThrow('reserved by another application team');
  });

  test('blocks live foreign mounts after a manifest changes or becomes malformed', async () => {
    for (const manifest of ['services:\n  web:\n    image: nginx\n', 'services: [broken']) {
      const f = await fixture();
      const a = await f.app();
      const foreign = await f.app(f.otherTeam, { manifest });
      const live = await f.mounted(foreign);
      await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([live]))).rejects.toThrow('outside this application');
    }
  });

  test('allows adopted own mounts and explicitly declared same-team sharing', async () => {
    const f = await fixture();
    const a = await f.app();
    const sameTeam = await f.app();
    const live = await f.mounted(sameTeam);
    await assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([live]));
    await assertDeploymentVolumeAccess(sameTeam, f.worker, f.plan(sameTeam), f.source([live]));
  });

  test('a foreign manifest cannot take ownership away from an attributable existing mount', async () => {
    const f = await fixture();
    const victim = await f.app();
    const attacker = await f.app(f.otherTeam);
    const live = await f.mounted(victim);
    await assertDeploymentVolumeAccess(victim, f.worker, f.plan(victim), f.source([live]));
    await expect(assertDeploymentVolumeAccess(attacker, f.worker, f.plan(attacker), f.source([live]))).rejects.toThrow('outside this application');
  });

  test('uses current ownership after async worker inspection', async () => {
    const f = await fixture();
    const a = await f.app();
    const sameTeam = await f.app();
    const live = await f.mounted(sameTeam);
    const source = f.source([live]);
    source.getContainer = async () => {
      db.update(applications).set({ teamId: f.otherTeam }).where(eq(applications.id, sameTeam.id)).run();
      return live;
    };
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), source)).rejects.toThrow('outside this application');
  });

  test('refuses target storage edits made during worker inspection', async () => {
    const f = await fixture();
    const a = await f.app();
    const live = await f.mounted(a);
    const source = f.source([live]);
    source.getContainer = async () => {
      db.update(applications).set({ teamId: f.otherTeam }).where(eq(applications.id, a.id)).run();
      return live;
    };
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), source)).rejects.toThrow('configuration changed');
  });

  test('accepts a new bare volume and refuses an unattributed existing one', async () => {
    const f = await fixture();
    const a = await f.app();
    await assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []));
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source())).rejects.toThrow('without an attributable application mount');
  });

  test('does not trust application labels on unrecorded containers', async () => {
    const f = await fixture();
    const a = await f.app();
    const live: ContainerInspect = { Id: 'unknown', Name: '/unknown', HostConfig: { Binds: [] }, Mounts: [{ Type: 'volume', Name: 'pgdata' }], Config: { Image: 'nginx', Labels: { 'rudder.app.id': a.id, 'rudder.managed': 'true' } }, State: { Running: true, Status: 'running', Pid: 1, ExitCode: 0 }, NetworkSettings: { IPAddress: '' } };
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([live]))).rejects.toThrow('outside this application');
  });

  test('fails closed when inspecting a worker fails', async () => {
    const f = await fixture();
    const a = await f.app();
    const source = f.source([await f.mounted(a)]);
    source.getContainer = async () => { throw new Error('connection reset'); };
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), source)).rejects.toThrow('Could not verify volume ownership');
  });

  test('single-container adopted bare names receive the same guard', async () => {
    const f = await fixture();
    const a = await f.app(f.owner, { type: 'single', manifest: JSON.stringify({ image: 'postgres:16' }), volumes: JSON.stringify([{ hostPath: 'pgdata', containerPath: '/data' }]) });
    await f.app(f.otherTeam);
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []))).rejects.toThrow('reserved by another application team');
  });

  test('registry references require the same team and assigned worker', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(volumes).values({ id, name: 'registered', containerPath: '/data', teamId: f.otherTeam, workerId: f.worker.id, createdAt: now, updatedAt: now });
    cleanups.push(() => db.delete(volumes).where(eq(volumes.id, id)));
    const a = await f.app(f.owner, { type: 'single', manifest: JSON.stringify({ image: 'postgres:16' }), volumes: JSON.stringify([{ volumeId: id }]) });
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []))).rejects.toThrow('referenced volume is unavailable');
    await db.update(volumes).set({ teamId: f.owner }).where(eq(volumes.id, id));
    await assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []));
    // Null denotes the global registry choices explicitly offered by the form.
    await db.update(volumes).set({ teamId: null }).where(eq(volumes.id, id));
    await assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []));
    const other = await fixture();
    await db.update(volumes).set({ workerId: other.worker.id }).where(eq(volumes.id, id));
    await expect(assertDeploymentVolumeAccess(a, f.worker, f.plan(a), f.source([], []))).rejects.toThrow('referenced volume is unavailable');
    await db.update(volumes).set({ workerId: f.worker.id }).where(eq(volumes.id, id));
  });

  test('preserves app-scoped names and foreign-name refusal', async () => {
    const f = await fixture();
    const a = await f.app();
    const plan = f.plan(a);
    plan.containers[0].mounts = [{ kind: 'volume', name: `rudder-${a.id.slice(0, 8)}-db-data`, target: '/data', mode: 'rw' }];
    await assertDeploymentVolumeAccess(a, f.worker, plan, f.source());
    plan.containers[0].mounts = [{ kind: 'volume', name: 'rudder-00000000-db-data', target: '/data', mode: 'rw' }];
    await expect(assertDeploymentVolumeAccess(a, f.worker, plan, f.source())).rejects.toThrow('belongs to another application');
  });

  test('shared deploy refuses foreign data before any destructive worker request', async () => {
    const f = await fixture();
    const a = await f.app();
    const foreign = await f.app(f.otherTeam, { manifest: 'malformed: [' });
    const live = await f.mounted(foreign);
    await f.mounted(a, ['own:/data:rw']);
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.endsWith('/volumes/json')) return Response.json([{ Name: 'pgdata' }]);
      if (path === '/containers/json') return Response.json([{ Id: live.Id, Names: [live.Name] }]);
      if (path === `/containers/${live.Id}/json`) return Response.json(live);
      return new Response('Unexpected request', { status: 500 });
    } });
    try {
      await db.update(workers).set({ podmanApiUrl: `http://127.0.0.1:${server.port}` }).where(eq(workers.id, f.worker.id));
      const result = await executeApplicationDeploy(a.id);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(409);
      expect(result.message).toContain('outside this application');
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.startsWith('GET '))).toBe(true);
      expect(await db.select().from(containers).where(eq(containers.applicationId, a.id)).all()).toHaveLength(1);
    } finally { evictPodmanClient(f.worker.id); server.stop(true); }
  });
});
