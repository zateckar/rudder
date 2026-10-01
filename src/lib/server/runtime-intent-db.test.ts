import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { applications, containers, users, workers } from '$lib/db/schema';
import { createSession } from '$lib/auth';
import { POST as applicationAction } from '../../routes/api/applications/deploy/+server';
import { PATCH as containerAction } from '../../routes/api/containers/[id]/+server';
import { POST as recreateContainer } from '../../routes/api/containers/[id]/recreate/+server';
import { executeApplicationDeploy } from './deploy';
import { desiredState, diff, toObserved } from './reconcile';
import { withLock, workerDeployLock } from './locks';
import { evictPodmanClient } from './podman-client';
import { synchronizeWorkerRuntimePolicies } from './runtime-policy';

const workerId = 'runtime-intent-worker';
const appId = 'runtime-intent-app';
const userId = 'runtime-intent-admin';
let server: ReturnType<typeof Bun.serve>;
let cookies: any;
const runtime = new Map<string, string>();
const calls: string[] = [];
const markers = new Map<string, string>();
const helpers = new Map<string, { id: string; intent: string }>();
let failStop = false;
let failMarker = false;
const auth = {
  user: { id: userId, username: userId, email: `${userId}@example.com`, role: 'admin', fullName: userId },
  sessionUserId: userId,
};

async function app() {
  return (await db.select().from(applications).where(eq(applications.id, appId)).get())!;
}
async function rows() {
  return db.select().from(containers).where(eq(containers.applicationId, appId)).all();
}
async function report() {
  const worker = (await db.select().from(workers).where(eq(workers.id, workerId)).get())!;
  const records = await rows();
  return diff({
    desired: [desiredState({ app: await app(), worker })],
    rows: records,
    observed: records.map((r) => toObserved({
      Id: r.containerId, Names: [r.name], Image: r.image, State: runtime.get(r.containerId)!,
      Status: runtime.get(r.containerId)!, Labels: {},
    } as any)),
    knownAppIds: new Set([appId]),
  });
}
function appRequest(action: string) {
  return applicationAction({ cookies, request: new Request('http://localhost/api/applications/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ applicationId: appId, action }),
  }) });
}
function containerRequest(action: string) {
  return containerAction({ params: { id: 'runtime-intent-row-0' }, locals: { auth },
    request: new Request('http://localhost/api/containers/test', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    }),
  } as any);
}

beforeAll(async () => {
  server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/images/create') return new Response('{"status":"done"}\n', { status: 200 });
    if (path.startsWith('/images/') && path.endsWith('/json')) {
      return Response.json({ Id: 'sha256:test', RepoTags: ['docker.io/library/nginx:1.27'] });
    }
    if (path === '/containers/create') {
      const config = await request.json() as any;
      if (config.Cmd?.[3] === 'rudder-runtime-intent') {
        const id = `helper${helpers.size}`;
        helpers.set(id, { id: config.Cmd[4], intent: config.Cmd[5] });
        expect(config.HostConfig.RestartPolicy.Name).toBe('no');
        expect(config.HostConfig.Binds).toContain('/usr/local/bin:/rudder-host-bin:rw');
        expect(config.HostConfig.Binds).toContain('/var/lib:/rudder-var-lib:rw');
        expect(config.Cmd[2]).toContain('mv -f "$guard" /rudder-host-bin/rudder-container-boot.sh');
        expect(config.Cmd[2].indexOf('rudder-container-boot.sh')).toBeLessThan(config.Cmd[2].indexOf('runtime-intent; mkdir'));
        return Response.json({ Id: id, Warnings: [] });
      }
      calls.push('create');
      runtime.set('recreated', 'created');
      return Response.json({ Id: 'recreated', Warnings: [] });
    }
    const inspect = /^\/containers\/(runtime\d+|recreated|pending0)\/json$/.exec(path);
    if (inspect) {
      const id = inspect[1];
      return Response.json({ Id: id, Name: '/runtime-intent', State: { Running: runtime.get(id) === 'running' },
        Config: { Image: 'nginx:1.27', Env: [], Labels: {} },
        HostConfig: { RestartPolicy: { Name: 'always' } },
      });
    }
    const helperCall = /^\/containers\/(helper\d+)(?:\/(start|wait))?$/.exec(path);
    if (helperCall) {
      const helper = helpers.get(helperCall[1])!;
      if (helperCall[2] === 'wait') {
        if (!failMarker) markers.set(helper.id, helper.intent);
        return Response.json({ StatusCode: failMarker ? 1 : 0 });
      }
      return new Response(null, { status: 204 });
    }
    if (path === '/containers/runtime0' && request.method === 'DELETE') {
      calls.push('remove:runtime0');
      runtime.delete('runtime0');
      return new Response(null, { status: 204 });
    }
    const match = /^\/containers\/(\w+)\/(start|stop|restart)$/.exec(path);
    if (!match) return new Response('unexpected Podman call', { status: 500 });
    const [, id, action] = match;
    calls.push(`${action}:${id}`);
    // The request must be saved even while the remote call is in progress.
    const row = (await rows()).find((r) => r.containerId === id)!;
    expect(row.desiredStatus ?? (await app()).desiredStatus).toBe(action === 'stop' ? 'stopped' : 'running');
    if (failStop && action === 'stop' && id === 'runtime0') {
      return Response.json({ message: 'stop refused' }, { status: 500 });
    }
    runtime.set(id, action === 'stop' ? 'exited' : 'running');
    return new Response(null, { status: 204 });
  } });
  const now = new Date();
  await db.insert(users).values({ ...auth.user, passwordHash: null, role: 'admin', createdAt: now, updatedAt: now });
  const session = await createSession(userId);
  cookies = { get: () => session };
  await db.insert(workers).values({ id: workerId, name: workerId, hostname: 'localhost',
    sshUser: 'root',
    podmanApiUrl: `http://localhost:${server.port}`, status: 'online', createdAt: now });
  await db.insert(applications).values({ id: appId, workerId, name: 'runtime-intent',
    manifest: 'nginx:1.27', replicas: 2, createdAt: now, updatedAt: now });
  const worker = (await db.select().from(workers).where(eq(workers.id, workerId)).get())!;
  const desired = desiredState({ app: await app(), worker });
  for (const [i, want] of desired.containers.entries()) {
    runtime.set(`runtime${i}`, 'running');
    await db.insert(containers).values({ id: `runtime-intent-row-${i}`, applicationId: appId, workerId,
      containerId: `runtime${i}`, name: want.name, image: 'nginx:1.27', status: 'running',
      specHash: want.specHash, createdAt: now, updatedAt: now });
  }
});

afterAll(() => { evictPodmanClient(workerId); server.stop(true); });

describe('manual runtime intent', () => {
  test('app stop persists across observation refreshes; one container can resume independently', async () => {
    expect((await appRequest('stop')).status).toBe(200);
    expect((await app()).desiredStatus).toBe('stopped');
    expect(markers.get('runtime0')).toBe('stopped');
    expect(markers.get('runtime1')).toBe('stopped');
    // Emulate repeated fleet observations changing status timestamps.
    for (let i = 0; i < 3; i++) {
      await db.update(containers).set({ status: 'exited', updatedAt: new Date() })
        .where(eq(containers.applicationId, appId));
      expect((await report()).clean).toBe(true);
    }
    const callCount = calls.length;
    const repair = await executeApplicationDeploy(appId, userId, { respectRuntimeIntent: true });
    expect(repair.statusCode).toBe(409);
    expect(calls).toHaveLength(callCount);
    expect((await containerRequest('start')).status).toBe(200);
    expect(runtime.get('runtime0')).toBe('running');
    expect(markers.get('runtime0')).toBe('running');
    expect(markers.get('runtime1')).toBe('stopped');
    expect(runtime.get('runtime1')).toBe('exited');
    expect((await report()).clean).toBe(true);
  });

  test('app start and restart reset container stop overrides', async () => {
    expect((await appRequest('start')).status).toBe(200);
    expect((await app()).desiredStatus).toBe('running');
    expect((await rows()).every((r) => r.desiredStatus === null)).toBe(true);
    expect((await containerRequest('stop')).status).toBe(200);
    expect((await report()).clean).toBe(true);
    const callCount = calls.length;
    expect((await executeApplicationDeploy(appId, userId, { respectRuntimeIntent: true })).statusCode).toBe(409);
    expect(calls).toHaveLength(callCount);
    expect((await appRequest('restart')).status).toBe(200);
    expect((await rows()).every((r) => r.desiredStatus === null)).toBe(true);
    expect((await report()).clean).toBe(true);
  });

  test('partial failed stop retains stopped intent without falsifying observed status', async () => {
    failStop = true;
    try {
      const response = await appRequest('stop');
      expect((await response.json()).success).toBe(false);
      expect((await app()).desiredStatus).toBe('stopped');
      expect((await rows()).find((r) => r.containerId === 'runtime0')!.status).toBe('running');
      expect((await report()).drift.map((d) => d.kind)).toEqual(['unexpected-running']);
    } finally { failStop = false; }
  });

  test('lifecycle requests cannot race a deployment and overwrite its intent', async () => {
    const before = (await app()).desiredStatus;
    const callCount = calls.length;
    await withLock(workerDeployLock(workerId), { operation: 'deploy', holder: 'test-deploy' }, async () => {
      expect((await appRequest('start')).status).toBe(409);
      expect((await containerRequest('start')).status).toBe(409);
      expect((await appRequest('delete')).status).toBe(409);
      expect((await app()).desiredStatus).toBe(before);
      expect(calls).toHaveLength(callCount);
    });
  });

  test('resource recreation observes a Stop completed during request parsing', async () => {
    expect((await appRequest('start')).status).toBe(200);
    let releaseBody!: (value: unknown) => void;
    let signalParsing!: () => void;
    const body = new Promise((resolve) => { releaseBody = resolve; });
    const parsing = new Promise<void>((resolve) => { signalParsing = resolve; });
    const pending = recreateContainer({ params: { id: 'runtime-intent-row-0' }, locals: { auth },
      request: { json: () => { signalParsing(); return body; } },
    } as any);
    await parsing;
    expect((await containerRequest('stop')).status).toBe(200);
    const callCount = calls.length;
    releaseBody({ memory: 1024 });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(calls.slice(callCount)).toEqual(['remove:runtime0', 'create']);
    expect(runtime.get('recreated')).toBe('created');
    expect(markers.get('recreated')).toBe('stopped');
    expect((await report()).clean).toBe(true);
  });

  test('failure to persist worker intent cannot report a completed stop', async () => {
    await appRequest('start');
    failMarker = true;
    try {
      const before = calls.length;
      const response = await appRequest('stop');
      expect((await response.json()).success).toBe(false);
      expect(calls.slice(before)).toEqual([]);
      expect((await app()).desiredStatus).toBe('stopped');
    } finally { failMarker = false; }
  });

  test('synchronization populates pending, draining, and old stopped rows and preserves running siblings', async () => {
    await db.update(applications).set({ desiredStatus: 'running' }).where(eq(applications.id, appId));
    await db.update(containers).set({ state: 'draining', desiredStatus: null })
      .where(eq(containers.id, 'runtime-intent-row-0'));
    runtime.set('pending0', 'created');
    await db.insert(containers).values({ id: 'runtime-intent-pending', applicationId: appId, workerId,
      containerId: 'pending0', name: 'runtime-intent-pending', image: 'nginx:1.27', status: 'created',
      state: 'pending', createdAt: new Date(), updatedAt: new Date() });
    const result = await synchronizeWorkerRuntimePolicies(workerId);
    expect(result.failures).toEqual([]);
    expect(markers.get('recreated')).toBe('stopped');
    expect(markers.get('runtime1')).toBe('running');
    expect(markers.get('pending0')).toBe('stopped');
  });

  test('direct start cannot make a retained generation boot-eligible', async () => {
    const before = calls.length;
    expect((await containerRequest('start')).status).toBe(409);
    expect((await containerRequest('restart')).status).toBe(409);
    expect(calls).toHaveLength(before);
    expect((await rows()).find((r) => r.id === 'runtime-intent-row-0')!.desiredStatus).toBeNull();
    expect(markers.get('recreated')).toBe('stopped');
  });
});

test('runtime intent migration upgrades existing rows without treating crashes as manual stops', () => {
  const sqlite = new Database(':memory:');
  try {
    for (const file of ['0000_baseline', '0001_auth_type_default_and_orphan_indexes', '0002_deployment_failure_logs']) {
      for (const statement of readFileSync(`drizzle/${file}.sql`, 'utf8').split('--> statement-breakpoint')) sqlite.run(statement);
    }
    sqlite.run("INSERT INTO applications (id, name, created_at, updated_at) VALUES ('a', 'old', 0, 0)");
    sqlite.run("INSERT INTO containers (id, application_id, container_id, name, image, status, created_at, updated_at) VALUES ('c', 'a', 'cid', 'old', 'nginx', 'exited', 0, 0)");
    for (const statement of readFileSync('drizzle/0003_desired_runtime_state.sql', 'utf8').split('--> statement-breakpoint')) sqlite.run(statement);
    expect(sqlite.query('SELECT desired_status FROM applications').get()).toEqual({ desired_status: 'running' });
    expect(sqlite.query('SELECT status, desired_status FROM containers').get()).toEqual({ status: 'exited', desired_status: null });
  } finally { sqlite.close(); }
});
