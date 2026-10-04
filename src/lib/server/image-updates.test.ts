import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, auditLogs, containers, deployments, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { createServer } from 'node:http';
import {
  checkApplicationImageUpdates,
  imageUpdateConfigurationIsCurrent,
  imageUpdateIsDue,
  resolveApplicationImageUpdate,
} from './image-updates';
import { executeApplicationDeploy } from './deploy';
import { parseDigestRecord } from './image-digests';
import { evictPodmanClient } from './podman-client';
import { createPodmanClient } from './podman';
import { isLocked, withLock, workerDeployLock } from './locks';

const OLD = `docker.io/library/nginx@sha256:${'1'.repeat(64)}`;
const NEW = `docker.io/library/nginx@sha256:${'2'.repeat(64)}`;
const REDIS = `docker.io/library/redis@sha256:${'3'.repeat(64)}`;
let server: ReturnType<typeof Bun.serve>;
let fixtureIds: Array<{ appId: string; workerId: string }> = [];
let calls: string[] = [];
let createdImages: string[] = [];
let failingImages = new Set<string>();
let onPull: ((image: string) => Promise<void>) | undefined;

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    calls.push(`${request.method} ${path}`);
    if (path === '/images/create') {
      const image = url.searchParams.get('fromImage')!;
      await onPull?.(image);
      if (failingImages.has(image)) {
        return new Response('{"status":"pulling"}\n{"errorDetail":{"message":"registry unavailable"},"error":"registry unavailable"}\n');
      }
      return new Response('{"status":"pulling"}\n{"status":"done"}\n');
    }
    if (path.startsWith('/images/') && path.endsWith('/json')) {
      const image = decodeURIComponent(path.slice('/images/'.length, -'/json'.length));
      return Response.json({ Id: 'sha256:image', RepoDigests: [image.includes('@') ? image : NEW] });
    }
    if (path === '/containers/create') {
      const config = await request.json() as any;
      const helper = config.Cmd?.[3] === 'rudder-runtime-intent';
      if (!helper) createdImages.push(config.Image);
      return Response.json({ Id: `imageupdate${crypto.randomUUID().replaceAll('-', '')}`, Warnings: [] });
    }
    if (path.startsWith('/containers/') && path.endsWith('/json')) {
      return Response.json({
        Id: path.split('/')[2], Config: { Labels: { 'rudder.managed': 'true' } },
        State: { Running: true, Status: 'running', ExitCode: 0 }, HostConfig: {},
      });
    }
    if (path.endsWith('/wait')) return Response.json({ StatusCode: 0 });
    if (path.endsWith('/logs')) return new Response('');
    return Response.json({});
  } });
});

beforeEach(() => {
  calls = [];
  createdImages = [];
  failingImages = new Set();
  onPull = undefined;
});

afterEach(async () => {
  for (const { appId, workerId } of fixtureIds) {
    await db.delete(auditLogs).where(eq(auditLogs.resourceId, appId));
    await db.delete(containers).where(eq(containers.applicationId, appId));
    await db.delete(deployments).where(eq(deployments.applicationId, appId));
    await db.delete(applications).where(eq(applications.id, appId));
    evictPodmanClient(workerId);
    await db.delete(workers).where(eq(workers.id, workerId));
  }
  fixtureIds = [];
});
afterAll(() => { server.stop(true); });

async function fixture(options: {
  type?: 'single' | 'compose' | 'k8s'; manifest?: string;
  digests?: string | null; replicas?: number;
} = {}) {
  const appId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  fixtureIds.push({ appId, workerId });
  const now = new Date();
  await db.insert(workers).values({
    id: workerId, name: 'image-update-test', hostname: 'update.example.com',
    sshUser: 'root', podmanApiUrl: server.url.origin, routingMode: 'labels',
    status: 'online', createdAt: now,
  });
  await db.insert(applications).values({
    // Unique per fixture: the name derives the app's domain, and deploys refuse
    // a domain another application already holds.
    id: appId, workerId, name: `update-test-${appId.slice(0, 8)}`, authType: 'none',
    type: options.type ?? 'single', replicas: options.replicas ?? 1,
    manifest: options.manifest ?? JSON.stringify({ image: 'nginx:latest' }),
    autoUpdateEnabled: true, createdAt: now, updatedAt: now,
  });
  const app = (await db.select().from(applications).where(eq(applications.id, appId)).get())!;
  const worker = (await db.select().from(workers).where(eq(workers.id, workerId)).get())!;
  const deploymentId = crypto.randomUUID();
  await db.insert(deployments).values({
    id: deploymentId, applicationId: appId, version: 1, manifest: app.manifest,
    imageDigest: options.digests === undefined ? OLD : options.digests,
    status: 'succeeded', createdAt: now, finishedAt: now,
  });
  await db.insert(containers).values({
    id: crypto.randomUUID(), applicationId: appId, workerId, containerId: `old${appId.replaceAll('-', '')}`,
    name: 'update-test-old', image: 'nginx:latest', status: 'running', state: 'active',
    deploymentId, createdAt: now, updatedAt: now,
  });
  return { app, worker, deploymentId };
}

function imageSource(digests: Record<string, string | null>) {
  const pulled: string[] = [];
  return {
    pulled,
    pullImage: async (image: string) => { pulled.push(image); },
    resolveImageDigest: async (image: string) => digests[image] ?? null,
  };
}

describe('automatic image check scheduling', () => {
  const now = new Date('2026-10-03T10:00:00Z').getTime();
  const settings = { autoUpdateEnabled: true, autoUpdateIntervalMinutes: 60, autoUpdateLastCheckedAt: null };
  test('requires explicit opt-in and checks newly enabled applications', () => {
    expect(imageUpdateIsDue({ ...settings, autoUpdateEnabled: false }, now)).toBe(false);
    expect(imageUpdateIsDue(settings, now)).toBe(true);
  });
  test('uses the persisted hour interval and exact boundary after restart', () => {
    const lastCheck = new Date(now - 60 * 60_000);
    expect(imageUpdateIsDue({ ...settings, autoUpdateLastCheckedAt: lastCheck }, now - 1)).toBe(false);
    expect(imageUpdateIsDue({ ...settings, autoUpdateLastCheckedAt: lastCheck }, now)).toBe(true);
    expect(imageUpdateIsDue({ ...settings, autoUpdateIntervalMinutes: 120, autoUpdateLastCheckedAt: lastCheck }, now)).toBe(false);
  });
  test('busy workers do not advance the last-check clock', async () => {
    const { app, worker } = await fixture();
    await withLock(workerDeployLock(worker.id), { operation: 'test mutation' }, async () => {
      const result = await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
      expect(result.statusCode).toBe(409);
    });
    expect(calls).toEqual([]);
    expect((await db.select().from(applications).where(eq(applications.id, app.id)).get())!.autoUpdateLastCheckedAt).toBeNull();
  });
  test('reassignment before lock acquisition cannot check a different locked worker', async () => {
    const first = await fixture();
    const second = await fixture();
    await withLock(workerDeployLock(second.worker.id), { operation: 'test mutation' }, async () => {
      const attempt = executeApplicationDeploy(first.app.id, null, { automaticImageUpdate: true });
      // The initial joined read has completed synchronously, but its await has
      // not resumed. This edit must not send the callback to an unlocked target.
      db.update(applications).set({ workerId: second.worker.id }).where(eq(applications.id, first.app.id)).run();
      expect((await attempt).statusCode).toBe(409);
    });
    expect(calls).toEqual([]);
    expect((await db.select().from(applications).where(eq(applications.id, first.app.id)).get())!.autoUpdateLastCheckedAt).toBeNull();
  });
  test('a worker assigned after an empty initial lookup cannot be deployed without a lock', async () => {
    const { app, worker } = await fixture();
    db.update(applications).set({ workerId: null }).where(eq(applications.id, app.id)).run();
    const attempt = executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
    db.update(applications).set({ workerId: worker.id }).where(eq(applications.id, app.id)).run();
    expect((await attempt).success).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('image comparison', () => {
  test('unchanged bytes do not deploy, even with different Docker Hub spelling', async () => {
    const { app, worker } = await fixture();
    const source = imageSource({ 'nginx:latest': OLD.replace('docker.io/library/', '') });
    expect(await resolveApplicationImageUpdate(app, worker, source)).toBeNull();
    expect(source.pulled).toEqual(['nginx:latest']);
  });
  test('a changed tag returns the exact digest to deploy and pulls replicas once', async () => {
    const { app, worker } = await fixture({ replicas: 3 });
    const source = imageSource({ 'nginx:latest': NEW });
    const update = await resolveApplicationImageUpdate(app, worker, source);
    expect(update).toEqual({ pinnedDigests: NEW, images: ['nginx:latest'] });
    expect(source.pulled).toEqual(['nginx:latest']);
  });
  test('checks all Compose services and pins unchanged services too', async () => {
    const { app, worker } = await fixture({ type: 'compose',
      manifest: 'services:\n  web:\n    image: nginx:latest\n  cache:\n    image: redis:7',
      digests: JSON.stringify({ web: OLD, cache: REDIS }),
    });
    const source = imageSource({ 'nginx:latest': NEW, 'redis:7': REDIS });
    const update = await resolveApplicationImageUpdate(app, worker, source);
    expect(parseDigestRecord(update!.pinnedDigests)).toEqual(new Map([['cache', REDIS], ['web', NEW]]));
    expect(update!.images).toEqual(['nginx:latest']);
  });
  test('deduplicates tags shared by Compose services', async () => {
    const { app, worker } = await fixture({ type: 'compose',
      manifest: 'services:\n  web:\n    image: nginx:latest\n  other:\n    image: nginx:latest',
      digests: JSON.stringify({ web: OLD, other: OLD }),
    });
    const source = imageSource({ 'nginx:latest': NEW });
    expect(await resolveApplicationImageUpdate(app, worker, source)).not.toBeNull();
    expect(source.pulled).toEqual(['nginx:latest']);
  });
  test('uses Kubernetes container digest keys', async () => {
    const { app, worker } = await fixture({ type: 'k8s', manifest:
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:latest',
      digests: JSON.stringify({ web: OLD }),
    });
    const source = imageSource({ 'nginx:latest': NEW });
    const update = await resolveApplicationImageUpdate(app, worker, source);
    expect(parseDigestRecord(update!.pinnedDigests).get('web')).toBe(NEW);
    expect(source.pulled).toEqual(['nginx:latest']);
  });
  test('skips immutable images', async () => {
    const { app, worker } = await fixture({ manifest: JSON.stringify({ image: OLD }) });
    const source = imageSource({});
    expect(await resolveApplicationImageUpdate(app, worker, source)).toBeNull();
    expect(source.pulled).toEqual([]);
  });
  test('requires a known active deployment and complete digests', async () => {
    const { app, worker } = await fixture({ digests: null });
    const source = imageSource({ 'nginx:latest': NEW });
    expect(await resolveApplicationImageUpdate(app, worker, source)).toBeNull();
    await db.update(deployments).set({ imageDigest: OLD }).where(eq(deployments.applicationId, app.id));
    await db.update(containers).set({ deploymentId: null }).where(eq(containers.applicationId, app.id));
    expect(await resolveApplicationImageUpdate(app, worker, source)).toBeNull();
    expect(source.pulled).toEqual([]);
  });
  test('compares with active rollback bytes rather than latest successful history', async () => {
    const { app, worker } = await fixture();
    await db.insert(deployments).values({ id: crypto.randomUUID(), applicationId: app.id,
      version: 2, manifest: app.manifest, imageDigest: NEW, status: 'succeeded', createdAt: new Date(),
    });
    expect(await resolveApplicationImageUpdate(app, worker, imageSource({ 'nginx:latest': NEW }))).not.toBeNull();
  });
  test('saved manifest changes need an explicit deployment before checking', async () => {
    const { app, worker } = await fixture();
    const source = imageSource({ 'nginx:latest': NEW });
    expect(await resolveApplicationImageUpdate({ ...app, manifest: 'nginx:alpine' }, worker, source)).toBeNull();
    expect(source.pulled).toEqual([]);
  });
  test('missing or unrelated pulled digests cannot trigger a deployment', async () => {
    const { app, worker } = await fixture();
    await expect(resolveApplicationImageUpdate(app, worker, imageSource({}))).rejects.toThrow('Cannot determine');
    await expect(resolveApplicationImageUpdate(app, worker, imageSource({ 'nginx:latest': REDIS }))).rejects.toThrow('Cannot determine');
  });
});

describe('automatic deploy safeguards and execution', () => {
  test('disabled, offline, and not-yet-due applications make no Podman calls', async () => {
    const { app, worker } = await fixture();
    await db.update(applications).set({ autoUpdateEnabled: false }).where(eq(applications.id, app.id));
    expect((await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true })).success).toBe(true);
    await db.update(applications).set({ autoUpdateEnabled: true }).where(eq(applications.id, app.id));
    await db.update(workers).set({ status: 'offline' }).where(eq(workers.id, worker.id));
    await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
    await db.update(workers).set({ status: 'online' }).where(eq(workers.id, worker.id));
    await db.update(applications).set({ autoUpdateLastCheckedAt: new Date() }).where(eq(applications.id, app.id));
    await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
    expect(calls).toEqual([]);
  });
  test('manual application and container stops are respected', async () => {
    const { app } = await fixture();
    await db.update(applications).set({ desiredStatus: 'stopped' }).where(eq(applications.id, app.id));
    expect((await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true })).statusCode).toBe(409);
    await db.update(applications).set({ desiredStatus: 'running' }).where(eq(applications.id, app.id));
    await db.update(containers).set({ desiredStatus: 'stopped' }).where(eq(containers.applicationId, app.id));
    expect((await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true })).statusCode).toBe(409);
    expect(calls).toEqual([]);
  });
  test('unchanged checks preserve the active containers and history', async () => {
    const { app } = await fixture({ digests: NEW });
    const result = await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
    expect(result.message).toBe('No new image available');
    expect(createdImages).toEqual([]);
    expect(await db.select().from(deployments).where(eq(deployments.applicationId, app.id)).all()).toHaveLength(1);
    expect((await db.select().from(applications).where(eq(applications.id, app.id)).get())!.autoUpdateLastCheckedAt).not.toBeNull();
  });
  test('deploys changed bytes by digest and records history and audit', async () => {
    const { app } = await fixture();
    const result = await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
    expect(result.success).toBe(true);
    expect(createdImages).toEqual([NEW]);
    const history = await db.select().from(deployments).where(eq(deployments.applicationId, app.id)).all();
    const latest = history.find((row) => row.version === 2)!;
    expect(latest.status).toBe('succeeded');
    expect(latest.imageDigest).toBe(NEW);
    expect(latest.notes).toContain('Automatically deployed');
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, app.id)).get();
    expect(JSON.parse(audit!.details!).via).toBe('image_update');
    await checkApplicationImageUpdates();
    expect(createdImages).toEqual([NEW]);
  });
  test('HTTP-200 progress errors fail closed and retry at the configured interval', async () => {
    const { app } = await fixture();
    failingImages.add('nginx:latest');
    await expect(executeApplicationDeploy(app.id, null, { automaticImageUpdate: true })).rejects.toThrow('registry unavailable');
    expect(createdImages).toEqual([]);
    const current = (await db.select().from(applications).where(eq(applications.id, app.id)).get())!;
    expect(imageUpdateIsDue(current)).toBe(false);
    expect(await db.select().from(deployments).where(eq(deployments.applicationId, app.id)).all()).toHaveLength(1);
  });
  test('truncated pull responses reject and release the worker lock', async () => {
    const { app, worker } = await fixture();
    const truncated = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"status":"pulling"}\n');
      setTimeout(() => response.destroy(), 10);
    });
    await new Promise<void>((resolve) => truncated.listen(0, '127.0.0.1', resolve));
    const address = truncated.address() as { port: number };
    await db.update(workers).set({ podmanApiUrl: `http://127.0.0.1:${address.port}` }).where(eq(workers.id, worker.id));
    try {
      await expect(executeApplicationDeploy(app.id, null, { automaticImageUpdate: true })).rejects.toThrow();
      expect(isLocked(workerDeployLock(worker.id))).toBe(false);
      expect(createdImages).toEqual([]);
      expect((await db.select().from(applications).where(eq(applications.id, app.id)).get())!.autoUpdateLastCheckedAt).not.toBeNull();
    } finally {
      evictPodmanClient(worker.id);
      await new Promise<void>((resolve) => truncated.close(() => resolve()));
    }
  });
  test('disabling updates during a pull cancels the deployment', async () => {
    const { app } = await fixture();
    onPull = async () => {
      await db.update(applications).set({ autoUpdateEnabled: false }).where(eq(applications.id, app.id));
    };
    const result = await executeApplicationDeploy(app.id, null, { automaticImageUpdate: true });
    expect(result.message).toContain('Configuration changed');
    expect(createdImages).toEqual([]);
  });
  test('configuration snapshots ignore scheduling time but detect changed settings', async () => {
    const { app } = await fixture();
    expect(imageUpdateConfigurationIsCurrent(app, { ...app, autoUpdateLastCheckedAt: new Date() })).toBe(true);
    expect(imageUpdateConfigurationIsCurrent(app, { ...app, manifest: 'nginx:alpine' })).toBe(false);
    expect(imageUpdateConfigurationIsCurrent(app, { ...app, autoUpdateIntervalMinutes: 120 })).toBe(false);
  });
  test('one registry failure does not stop checking another worker', async () => {
    const failed = await fixture({ manifest: 'example.com/fail:latest', digests: `example.com/fail@sha256:${'1'.repeat(64)}` });
    const good = await fixture({ digests: NEW });
    failingImages.add('example.com/fail:latest');
    await checkApplicationImageUpdates();
    for (const { app } of [failed, good]) {
      expect((await db.select().from(applications).where(eq(applications.id, app.id)).get())!.autoUpdateLastCheckedAt).not.toBeNull();
    }
    expect(calls.filter((call) => call === 'POST /images/create')).toHaveLength(2);
  });
  test('digest pulls also reject error frames after initial progress', async () => {
    const client = createPodmanClient({ apiUrl: server.url.origin });
    failingImages.add('docker.io/library/nginx');
    try { await expect(client.pullImage(NEW)).rejects.toThrow('registry unavailable'); }
    finally { client.destroy(); }
  });
});
