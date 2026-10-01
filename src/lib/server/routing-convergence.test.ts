import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { GET, POST } from '../../routes/api/workers/[id]/traefik-config/+server';
import { acknowledgeRoutingSnapshot, expectedRoutingHash, routingSnapshot, waitForRoutingAcknowledgement } from './routing-convergence';

const workerId = 'routing-ack-test-worker';
const appId = 'routing-ack-test-app';
const token = 'routing-ack-test-token';
function event(method: string, value?: unknown, credential = token, headers: Record<string, string> = {}) {
  return { params: { id: workerId }, setHeaders() {}, request: new Request(`https://rudder.test/api/workers/${workerId}/traefik-config`, {
    method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(value) } : {}),
  }) } as any;
}
function worker() { return db.select().from(workers).where(eq(workers.id, workerId)).get()!; }
beforeAll(() => {
  const now = new Date();
  db.insert(workers).values({ id: workerId, name: workerId, hostname: 'localhost', sshUser: 'root',
    podmanApiUrl: 'http://localhost:9999', routingMode: 'http', configToken: token, createdAt: now }).run();
  db.insert(applications).values({ id: appId, name: 'routing-ack-test', workerId, manifest: 'nginx',
    createdAt: now, updatedAt: now }).run();
});
afterAll(() => {
  db.delete(containers).where(eq(containers.applicationId, appId)).run();
  db.delete(applications).where(eq(applications.id, appId)).run();
  db.delete(workers).where(eq(workers.id, workerId)).run();
});

describe('routing installation acknowledgement', () => {
  test('fetch and conditional fetch never acknowledge installation', async () => {
    const response = await GET(event('GET'));
    expect(response.status).toBe(200);
    const hash = response.headers.get('x-rudder-config-hash');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(worker().configFetchedAt).not.toBeNull();
    expect(worker().configAppliedHash).toBeNull();
    const unchanged = await GET(event('GET', undefined, token, { 'If-None-Match': response.headers.get('etag')! }));
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('x-rudder-config-hash')).toBe(hash);
    expect(await waitForRoutingAcknowledgement(workerId, hash!, 0)).toBe(false);
  });
  test('wrong credentials and invalid/wrong hashes cannot acknowledge', async () => {
    expect((await POST(event('POST', { hash: 'a'.repeat(64) }, 'wrong-token'))).status).toBe(401);
    expect((await POST(event('POST', { hash: 'not-a-hash' }))).status).toBe(400);
    expect((await POST(event('POST', { hash: 'a'.repeat(64) }))).status).toBe(409);
    expect(worker().configAppliedHash).toBeNull();
  });
  test('a formerly served body is rejected after backend replacement with the same router names', async () => {
    const oldHash = await expectedRoutingHash(workerId);
    const now = new Date();
    db.insert(containers).values({ id: 'routing-ack-test-row', applicationId: appId, workerId,
      containerId: 'routing-ack-runtime', name: 'routing-ack-test', image: 'nginx', status: 'running',
      domain: 'routing-ack.example.com', routerName: 'routing-ack-test', exposedPort: 31001,
      createdAt: now, updatedAt: now }).run();
    db.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
    expect((await POST(event('POST', { hash: oldHash }))).status).toBe(409);
    const newHash = await expectedRoutingHash(workerId);
    expect((await POST(event('POST', { hash: newHash }))).status).toBe(200);
    expect(await waitForRoutingAcknowledgement(workerId, newHash, 0)).toBe(true);
    db.update(containers).set({ exposedPort: 31002 }).where(eq(containers.id, 'routing-ack-test-row')).run();
    db.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
    expect((await POST(event('POST', { hash: newHash }))).status).toBe(409);
  });
  test('an asynchronously built snapshot cannot commit across a new routing revision', async () => {
    const snapshot = await routingSnapshot(workerId);
    db.update(workers).set({ routingRevision: sql`${workers.routingRevision} + 1`, configAppliedHash: null })
      .where(eq(workers.id, workerId)).run();
    expect(acknowledgeRoutingSnapshot(workerId, snapshot)).toBe(false);
    expect(worker().configAppliedHash).toBeNull();
  });
  test('an empty body can be positively acknowledged; proxy credential header also works', async () => {
    db.delete(containers).where(eq(containers.applicationId, appId)).run();
    const hash = await expectedRoutingHash(workerId);
    const response = await POST(event('POST', { hash }, 'Basic-proxy-credential', { 'X-Rudder-Config-Token': token }));
    expect(response.status).toBe(200);
    expect(worker().configAppliedHash).toBe(hash);
  });
  test('routing edits from any database writer invalidate acknowledgement, while telemetry does not', async () => {
    const now = new Date();
    db.insert(containers).values({ id: 'routing-ack-test-edit-row', applicationId: appId, workerId,
      containerId: 'routing-ack-edit-runtime', name: 'routing-ack-test', image: 'nginx', status: 'running',
      domain: 'routing-ack.example.com', routerName: 'routing-ack-test', exposedPort: 31003,
      createdAt: now, updatedAt: now }).run();
    const initial = await expectedRoutingHash(workerId);
    expect((await POST(event('POST', { hash: initial }))).status).toBe(200);
    db.update(workers).set({ lastSeenAt: now, configFetchedAt: now }).where(eq(workers.id, workerId)).run();
    expect(worker().configAppliedHash).toBe(initial);
    const appRevision = worker().routingRevision;
    db.update(applications).set({ rateLimitAvg: 20 }).where(eq(applications.id, appId)).run();
    expect(worker().routingRevision).toBeGreaterThan(appRevision);
    expect(worker().configAppliedHash).toBeNull();
    expect((await POST(event('POST', { hash: initial }))).status).toBe(409);
    const edited = await expectedRoutingHash(workerId);
    expect((await POST(event('POST', { hash: edited }))).status).toBe(200);
    const workerRevision = worker().routingRevision;
    db.update(workers).set({ baseDomain: 'new.example.com', oidcEnabled: true,
      oidcProviderUrl: 'https://idp.example.com', oidcClientId: 'test', oidcClientSecret: 'secret',
      oidcEncryptionKey: 'a'.repeat(32) }).where(eq(workers.id, workerId)).run();
    expect(worker().routingRevision).toBeGreaterThan(workerRevision);
    expect(worker().configAppliedHash).toBeNull();
    expect((await POST(event('POST', { hash: edited }))).status).toBe(409);
    const configured = await expectedRoutingHash(workerId);
    expect((await POST(event('POST', { hash: configured }))).status).toBe(200);
    const backendRevision = worker().routingRevision;
    db.update(containers).set({ exposedPort: 31004 }).where(eq(containers.id, 'routing-ack-test-edit-row')).run();
    expect(worker().routingRevision).toBeGreaterThan(backendRevision);
    expect(worker().configAppliedHash).toBeNull();
    expect((await POST(event('POST', { hash: configured }))).status).toBe(409);
  });
});
