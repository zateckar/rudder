import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createSession } from '#lib/auth/index.ts';
import { db } from '#lib/db/index.ts';
import { apiKeys, applications, containers, deployments, sessions, teams, users, workers } from '#lib/db/schema.ts';
import { applicationTask, getTask, launchTask } from '#lib/server/application-operations.ts';
import { hashKey } from '#lib/server/encryption.ts';
import { withLock, workerDeployLock } from '#lib/server/locks.ts';
import { evictPodmanClient } from '#lib/server/podman-client.ts';
import { eq } from 'drizzle-orm';
import { POST as deleteFromPanel } from './api/applications/deploy/+server';
import { DELETE as deleteFromKubernetes } from './k8s/apis/apps/v1/[...path]/+server';

const appId = crypto.randomUUID();
const workerId = crypto.randomUUID();
const assignedId = crypto.randomUUID();
const teamId = crypto.randomUUID();
const keyId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const token = crypto.randomUUID();
const path = 'namespaces/delete-test/deployments/delete-test';
const removals: string[] = [];
const present = new Set<string>();
let failingContainer: string | null;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === 'DELETE') {
      removals.push(pathname);
      if (pathname.startsWith('/networks/')) return new Response(null, { status: 204 });
      const id = pathname.slice('/containers/'.length);
      if (id === failingContainer) return Response.json({ message: 'worker operation failed' }, { status: 503 });
      if (present.delete(id)) return new Response(null, { status: 204 });
      return Response.json({ message: 'no such container' }, { status: 404 });
    }
    return new Response('unexpected request', { status: 500 });
  },
});

function clean() {
  db.delete(containers).where(eq(containers.applicationId, appId)).run();
  db.delete(deployments).where(eq(deployments.applicationId, appId)).run();
  db.delete(applications).where(eq(applications.id, appId)).run();
  for (const id of [workerId, assignedId]) {
    evictPodmanClient(id);
    db.delete(workers).where(eq(workers.id, id)).run();
  }
  db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
  db.delete(teams).where(eq(teams.id, teamId)).run();
  db.delete(sessions).where(eq(sessions.userId, adminId)).run();
  db.delete(users).where(eq(users.id, adminId)).run();
}

beforeEach(() => {
  clean();
  const now = new Date();
  db.insert(teams).values({ id: teamId, name: 'delete-test', slug: 'delete-test', createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({ id: keyId, teamId, name: 'delete-test', keyHash: hashKey(token), createdAt: now }).run();
  db.insert(users).values({ id: adminId, role: 'admin', username: 'delete-test', email: 'delete-test@example.test',
    fullName: 'Deletion test', createdAt: now, updatedAt: now }).run();
  db.insert(workers).values([
    { id: workerId, name: 'previous', hostname: 'previous.example.test', sshUser: 'root', podmanApiUrl: server.url.toString(), createdAt: now },
    { id: assignedId, name: 'assigned', hostname: 'assigned.example.test', sshUser: 'root', podmanApiUrl: server.url.toString(), createdAt: now },
  ]).run();
  db.insert(applications).values({ id: appId, teamId, name: 'delete-test', workerId: assignedId, createdAt: now, updatedAt: now }).run();
  db.insert(deployments).values({ id: crypto.randomUUID(), applicationId: appId, version: 1, status: 'succeeded', createdAt: now }).run();
  db.insert(containers).values(['first', 'second'].map((name) => ({
    id: crypto.randomUUID(), applicationId: appId, workerId, name, containerId: name,
    image: 'test', status: 'running', createdAt: now, updatedAt: now,
  }))).run();
  removals.length = 0;
  present.clear();
  present.add('first');
  present.add('second');
  failingContainer = null;
});

afterAll(() => {
  clean();
  server.stop(true);
});

function kubernetesDelete() {
  return deleteFromKubernetes({
    params: { path },
    request: new Request(`http://localhost/k8s/apis/apps/v1/${path}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }),
  });
}

function app() {
  return db.select().from(applications).where(eq(applications.id, appId)).get();
}

test('Kubernetes delete conflicts with a mutation on a previous worker', async () => {
  const response = await withLock(workerDeployLock(workerId), { operation: 'deploy test' }, kubernetesDelete);
  expect(response.status).toBe(409);
  expect((await response.json()).reason).toBe('Conflict');
  expect(app()).toBeDefined();
  expect(removals).toEqual([]);
});

test('a Podman failure leaves an application and history for retry through either API', async () => {
  const task = launchTask(applicationTask(app()!, 'deploy', adminId), async () => ({ success: true, message: 'done' }));
  await task.completion;
  failingContainer = 'second';
  const failed = await kubernetesDelete();
  expect(failed.status).toBe(502);
  expect(app()).toBeDefined();
  expect(db.select().from(deployments).where(eq(deployments.applicationId, appId)).all()).toHaveLength(1);
  expect(getTask(task.task.id)).toBeDefined();
  expect(db.select().from(containers).where(eq(containers.applicationId, appId)).all()).toHaveLength(2);
  expect(present.has('first')).toBe(false);
  expect(present.has('second')).toBe(true);

  failingContainer = null;
  const session = await createSession(adminId);
  const retried = await deleteFromPanel({
    request: new Request('http://localhost/api/applications/deploy', {
      method: 'POST', body: JSON.stringify({ action: 'delete', applicationId: appId }),
    }),
    cookies: { get: () => session },
  });
  expect(retried.status).toBe(200);
  expect(app()).toBeUndefined();
  expect(present.size).toBe(0);
  expect(removals.filter((path) => path === '/containers/first')).toHaveLength(2);
  expect(db.select().from(deployments).where(eq(deployments.applicationId, appId)).all()).toHaveLength(0);
  expect(getTask(task.task.id)).toBeUndefined();
});
