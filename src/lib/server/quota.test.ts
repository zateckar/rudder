import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { applications, auditLogs, containers, deployments, deployWebhooks, sessions, teamQuotas, teams, users, workers } from '$lib/db/schema';
import { createSession } from '$lib/auth';
import { buildDeploymentPlan } from './deploy/build';
import { checkDeployQuota, createApplicationWithQuota, plannedResources } from './quota';
import { executeApplicationDeploy } from './deploy';
import { hashKey } from './encryption';
import { POST as importApplication } from '../../routes/api/applications/import/+server';
import { PATCH as scaleApplication } from '../../routes/api/applications/[id]/scale/+server';
import { POST as webhookDeploy } from '../../routes/api/applications/[id]/webhook/trigger/+server';
import { POST as recreateContainer } from '../../routes/api/containers/[id]/recreate/+server';
import { evictPodmanClient } from './podman-client';

const suffix = crypto.randomUUID().slice(0, 8);
const teamId = `quota-team-${suffix}`;
const userId = `quota-admin-${suffix}`;
const workerIds = [`quota-worker-a-${suffix}`, `quota-worker-b-${suffix}`];
const auth = { user: { id: userId, username: userId, email: `${userId}@example.test`, role: 'admin' as const, fullName: userId }, sessionUserId: userId };
let server: ReturnType<typeof Bun.serve>;
let cookies: any;
let calls: string[] = [];
let onPull: (() => Promise<void>) | undefined;
let inspectedMemory = 1024;
const appIds: string[] = [];
const webhookIds: string[] = [];
let quotaIndex = 0;
const request = (body: unknown) => new Request('http://localhost/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function plan(manifest: string, type = 'single', replicas = 1) {
  let port = 31000;
  return buildDeploymentPlan({ manifest, type }, { appId: 'planned', appName: 'planned', replicas, restartPolicy: 'always', allocatePort: () => port++ });
}
function setQuota(values: Partial<typeof teamQuotas.$inferInsert>) {
  db.delete(teamQuotas).where(eq(teamQuotas.teamId, teamId)).run();
  db.insert(teamQuotas).values({ id: `quota-${suffix}-${quotaIndex++}`, teamId, createdAt: new Date(), updatedAt: new Date(), ...values }).run();
}
function app(values: Partial<typeof applications.$inferInsert> = {}) {
  const id = `quota-app-${suffix}-${appIds.length}`;
  appIds.push(id);
  db.insert(applications).values({ id, name: id, teamId, workerId: workerIds[0], type: 'single',
    authType: 'none', manifest: JSON.stringify({ image: 'nginx:latest', memoryLimit: '1M', cpuLimit: '0.5' }),
    createdAt: new Date(), updatedAt: new Date(), ...values }).run();
  return id;
}
function row(appId: string, resources: { cpuLimitCores?: number | null; memoryLimitBytes?: number | null } = {}) {
  const id = `quota-row-${crypto.randomUUID()}`;
  db.insert(containers).values({ id, applicationId: appId, workerId: workerIds[0], containerId: id,
    name: id, image: 'nginx:latest', status: 'running', createdAt: new Date(), updatedAt: new Date(), ...resources }).run();
  return id;
}

beforeAll(async () => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push(`${req.method} ${path}`);
    if (path === '/images/create') {
      await onPull?.();
      return new Response('{"status":"done"}\n');
    }
    if (path.startsWith('/images/') && path.endsWith('/json')) return Response.json({ RepoDigests: [`nginx@sha256:${'1'.repeat(64)}`] });
    if (path === '/containers/create') return Response.json({ Id: `quota-created-${crypto.randomUUID()}`, Warnings: [] });
    if (path.endsWith('/json') && path.startsWith('/containers/')) return Response.json({
      Id: path.split('/')[2], Name: '/quota', Config: { Image: 'nginx:latest', Labels: { 'rudder.managed': 'true' } },
      State: { Running: true, Status: 'running', ExitCode: 0 },
      HostConfig: { Memory: inspectedMemory, CpuQuota: 50_000, CpuPeriod: 100_000 },
    });
    if (path.endsWith('/wait')) return Response.json({ StatusCode: 0 });
    if (path.endsWith('/logs')) return new Response('');
    return Response.json({});
  } });
  db.insert(teams).values({ id: teamId, name: teamId, slug: teamId, createdAt: new Date(), updatedAt: new Date() }).run();
  db.insert(users).values({ ...auth.user, createdAt: new Date(), updatedAt: new Date() }).run();
  for (const id of workerIds) db.insert(workers).values({ id, name: id, hostname: 'localhost', sshUser: 'root', status: 'online',
    routingMode: 'labels', podmanApiUrl: `http://localhost:${server.port}`, createdAt: new Date() }).run();
  const token = await createSession(userId);
  cookies = { get: () => token };
});
beforeEach(() => { calls = []; onPull = undefined; setQuota({}); });
afterAll(() => {
  for (const id of appIds) {
    db.delete(auditLogs).where(eq(auditLogs.resourceId, id)).run();
    db.delete(containers).where(eq(containers.applicationId, id)).run();
    db.delete(deployments).where(eq(deployments.applicationId, id)).run();
    db.delete(deployWebhooks).where(eq(deployWebhooks.applicationId, id)).run();
    db.delete(applications).where(eq(applications.id, id)).run();
  }
  db.delete(teamQuotas).where(eq(teamQuotas.teamId, teamId)).run();
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
  db.delete(users).where(eq(users.id, userId)).run();
  db.delete(teams).where(eq(teams.id, teamId)).run();
  for (const id of workerIds) { evictPodmanClient(id); db.delete(workers).where(eq(workers.id, id)).run(); }
  server.stop(true);
});

test('import refuses a zero application quota without inserting a row', async () => {
  setQuota({ maxApplications: 0 });
  const name = `quota-import-${suffix}`;
  const response = await importApplication({ locals: { auth }, request: request({ name, teamId, workerId: workerIds[0], config: { type: 'single', manifest: 'nginx:latest' } }) } as any);
  expect(response.status).toBe(403);
  expect(db.select().from(applications).where(eq(applications.name, name)).get()).toBeUndefined();
});

test('application creation admits one synchronous check-and-insert at the remaining slot', async () => {
  const count = db.select().from(applications).where(eq(applications.teamId, teamId)).all().length;
  setQuota({ maxApplications: count + 1 });
  const ids = [0, 1].map((index) => `quota-atomic-${suffix}-${index}`);
  appIds.push(...ids);
  const verdicts = await Promise.all(ids.map(async (id) => createApplicationWithQuota({ id, name: id, teamId, createdAt: new Date(), updatedAt: new Date() })));
  expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(1);
});

test('actual Compose plan count is checked inside the shared deploy before any worker request', async () => {
  const id = app({ type: 'compose', manifest: 'services:\n  web:\n    image: nginx\n  api:\n    image: nginx\n  db:\n    image: redis' });
  setQuota({ maxContainers: 2 });
  expect(await executeApplicationDeploy(id)).toMatchObject({ success: false, statusCode: 403 });
  expect(calls).toEqual([]);
  expect(db.select().from(deployments).where(eq(deployments.applicationId, id)).all()).toEqual([]);
});

test('webhooks reach the same quota gate and cannot create a multi-service plan', async () => {
  const id = app({ type: 'compose', manifest: 'services:\n  web:\n    image: nginx\n  db:\n    image: redis' });
  const hookId = `quota-hook-${suffix}`;
  webhookIds.push(hookId);
  db.insert(deployWebhooks).values({ id: hookId, applicationId: id, token: hashKey('quota-token'), enabled: true, createdBy: userId, createdAt: new Date() }).run();
  setQuota({ maxContainers: 1 });
  const response = await webhookDeploy({ params: { id }, request: new Request('http://localhost/test', { method: 'POST', headers: { Authorization: 'Bearer quota-token' } }) });
  expect(response.status).toBe(403);
  expect(calls).toEqual([]);
});

test('denied scale preserves replicas and existing containers', async () => {
  const id = app();
  const oldRow = row(id);
  setQuota({ maxContainers: 1 });
  const response = await scaleApplication({ params: { id }, cookies, request: new Request('http://localhost/test', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicas: 3 }) }) });
  expect(response.status).toBe(403);
  expect(db.select().from(applications).where(eq(applications.id, id)).get()!.replicas).toBe(1);
  expect(db.select().from(containers).where(eq(containers.id, oldRow)).get()).toBeDefined();
  expect(calls).toEqual([]);
  db.delete(containers).where(eq(containers.id, oldRow)).run();
});

test('CPU and memory quotas use every actual replica limit and refuse missing limits', async () => {
  const id = app();
  const bounded = plan(JSON.stringify({ image: 'nginx', cpuLimit: '2', memoryLimit: '1G' }), 'single', 2);
  setQuota({ maxCpuCores: 3 });
  expect(await checkDeployQuota(teamId, id, bounded)).toMatchObject({ allowed: false });
  setQuota({ maxMemoryBytes: 1024 });
  expect(await checkDeployQuota(teamId, id, bounded)).toMatchObject({ allowed: false });
  setQuota({ maxCpuCores: 5, maxMemoryBytes: 3 * 1024 ** 3 });
  expect(await checkDeployQuota(teamId, id, bounded)).toEqual({ allowed: true });
  expect(await checkDeployQuota(teamId, id, plan('nginx'))).toMatchObject({ allowed: false });
  expect(plannedResources({ cpuQuota: -1, memory: 0 })).toEqual({ cpuLimitCores: null, memoryLimitBytes: null });
});

test('existing resource accounting uses deployed limits despite edits and replaces only the owning workload', async () => {
  const existing = app();
  const current = app();
  const existingRow = row(existing, { cpuLimitCores: 2, memoryLimitBytes: 2048 });
  const currentRow = row(current, { cpuLimitCores: 100, memoryLimitBytes: 99999 });
  db.update(applications).set({ manifest: 'nginx' }).where(eq(applications.id, existing)).run();
  setQuota({ maxCpuCores: 2.5, maxMemoryBytes: 3072 });
  const bounded = plan(JSON.stringify({ image: 'nginx', cpuLimit: '0.5', memoryLimit: '1K' }));
  expect(await checkDeployQuota(teamId, current, bounded)).toEqual({ allowed: true });
  db.update(containers).set({ cpuLimitCores: null }).where(eq(containers.id, existingRow)).run();
  expect(await checkDeployQuota(teamId, current, bounded)).toMatchObject({ allowed: false });
  db.delete(containers).where(eq(containers.id, existingRow)).run();
  db.delete(containers).where(eq(containers.id, currentRow)).run();
});

test('resource recreation cannot raise or clear bounds before deleting the old container', async () => {
  const id = app();
  const containerId = row(id, { cpuLimitCores: 0.5, memoryLimitBytes: 1024 });
  setQuota({ maxCpuCores: 1, maxMemoryBytes: 2048 });
  for (const body of [{ memory: 4096 }, { memory: 0 }, { cpuQuota: -1 }]) {
    const response = await recreateContainer({ locals: { auth }, params: { id: containerId }, request: request(body) } as any);
    expect(response.status).toBe(403);
    expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
    expect(db.select().from(containers).where(eq(containers.id, containerId)).get()!.containerId).toBe(containerId);
  }
  db.delete(containers).where(eq(containers.id, containerId)).run();
});

test('retained and abandoned own generations remain charged during blue/green allocation', async () => {
  const id = app();
  const active = row(id, { cpuLimitCores: 0.5, memoryLimitBytes: 1024 });
  const retained = row(id, { cpuLimitCores: 0.5, memoryLimitBytes: 1024 });
  db.update(containers).set({ state: 'draining', status: 'exited' }).where(eq(containers.id, retained)).run();
  setQuota({ maxContainers: 1 });
  expect(await checkDeployQuota(teamId, id, plan('nginx'), { keepInactive: true })).toMatchObject({ allowed: false });
  db.delete(containers).where(eq(containers.id, retained)).run();
  expect(await checkDeployQuota(teamId, id, plan('nginx'), { keepInactive: true })).toEqual({ allowed: true });
  expect(await checkDeployQuota(teamId, id, plan('nginx'), { keepInactive: true, keepActive: true })).toMatchObject({ allowed: false });
  db.delete(containers).where(eq(containers.id, active)).run();
});

test('deployments on separate workers cannot allocate the same team budget concurrently and stamp actual bounds', async () => {
  const first = app();
  const second = app({ workerId: workerIds[1] });
  setQuota({ maxContainers: 1, maxCpuCores: 1, maxMemoryBytes: 2 * 1024 ** 2 });
  let release!: () => void;
  let started!: () => void;
  const pendingPull = new Promise<void>((resolve) => { release = resolve; });
  const pulling = new Promise<void>((resolve) => { started = resolve; });
  onPull = async () => { started(); await pendingPull; };
  const deploying = executeApplicationDeploy(first);
  await pulling;
  try {
    expect(await executeApplicationDeploy(second)).toMatchObject({ success: false, statusCode: 409 });
  } finally { release(); }
  expect(await deploying).toMatchObject({ success: true });
  const recorded = db.select().from(containers).where(eq(containers.applicationId, first)).all();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ cpuLimitCores: 0.5, memoryLimitBytes: 1024 ** 2 });
  expect(await executeApplicationDeploy(second)).toMatchObject({ success: false, statusCode: 403 });
  db.delete(containers).where(eq(containers.applicationId, first)).run();
});
