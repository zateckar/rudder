import { afterEach, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '#lib/db/index.ts';
import { applications, containers, workers } from '#lib/db/schema.ts';
import { PUT } from '../../routes/api/applications/[id]/volumes/[name]/copy/+server';
import { isLocked, workerDeployLock } from './locks';
import { evictPodmanClient } from './podman-client';
import { buildTar } from './tar';
import { restoreFromCopy, restoreVolume } from './volume-ops';
import { COPY_SOURCE_LABEL, volumeCopyName } from './volumes';

type Volume = {
  Name: string;
  Labels: Record<string, string>;
  contents: string;
};
type Helper = { Cmd: string[]; HostConfig: { Binds: string[] } };

const appId = 'a4c3d2e1-9a89-4e8e-a724-07b557854388';
const target = `rudder-${appId.slice(0, 8)}-db-data`;
const copy = volumeCopyName(appId, target, 1700000000000);

let worker: typeof workers.$inferSelect;
let stop: () => void;
let store: Map<string, Volume>;
let helperRequests: number;
let failStaging: boolean;
let failArchive: boolean;
let hasArchiveRoot: boolean;
let targetFailures: number;
let runningId: string | undefined;
let liveProbeWasLocked: boolean;

beforeEach(() => {
  store = new Map<string, Volume>([
    [target, { Name: target, Labels: { custom: 'keep' }, contents: 'original' }],
    [copy, { Name: copy, Labels: { [COPY_SOURCE_LABEL]: target }, contents: 'replacement' }],
  ]);
  helperRequests = 0;
  failStaging = false;
  failArchive = false;
  hasArchiveRoot = true;
  targetFailures = 0;
  runningId = undefined;
  liveProbeWasLocked = false;

  const helpers = new Map<string, Helper>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/v4\.0\.0\/libpod/, '');
      if (path === '/volumes/json') return Response.json([...store.values()]);
      if (path === '/volumes/create') {
        const { Name, Labels } = await request.json() as Volume;
        store.set(Name, { Name, Labels, contents: '' });
        return Response.json(store.get(Name));
      }
      const volume = /^\/volumes\/([^/]+)(?:\/json)?$/.exec(path)?.[1];
      if (volume) {
        if (request.method === 'DELETE') {
          store.delete(volume);
          return new Response(null, { status: 204 });
        }
        const found = store.get(volume);
        return found ? Response.json(found) : Response.json({ message: 'no such volume' }, { status: 404 });
      }
      if (path === '/images/create') return Response.json({ status: 'Pulled' });
      if (path === '/containers/json') {
        liveProbeWasLocked = isLocked(workerDeployLock(worker.id));
        return Response.json(runningId ? [{ Id: runningId, State: 'running', Names: ['/live-database'], Labels: {} }] : []);
      }
      if (path === '/containers/create') {
        const id = `helper-${++helperRequests}`;
        helpers.set(id, await request.json() as Helper);
        return Response.json({ Id: id });
      }
      const operation = /^\/containers\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (!operation) return Response.json({ message: path }, { status: 404 });
      const [, id, action] = operation;
      const helper = helpers.get(id);
      if (!helper) return Response.json({ message: 'no such container' }, { status: 404 });
      if (!action || action === 'start') return new Response(null, { status: 204 });
      const mounts = new Map(helper.HostConfig.Binds.map((bind) => {
        const [name, mount] = bind.split(':');
        return [mount, store.get(name)];
      }));
      if (action === 'archive') {
        const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
        if (failArchive) return Response.json({ message: 'extract failed' }, { status: 500 });
        mounts.get('/restore')!.contents = new TextDecoder().decode(bytes.subarray(512, 528));
        return new Response(null, { status: 200 });
      }
      if (action === 'logs') return new Response('worker storage error');
      if (action === 'wait') {
        const from = mounts.get('/from');
        const to = mounts.get('/to');
        if (!to) return Response.json({ StatusCode: hasArchiveRoot ? 0 : 1 });
        if (failStaging && to.Name.includes('-restore-stage-')) return Response.json({ StatusCode: 1 });
        if (to.Name === target && targetFailures > 0) {
          targetFailures -= 1;
          to.contents = 'partial';
          return Response.json({ StatusCode: 1 });
        }
        to.contents = from!.contents;
        return Response.json({ StatusCode: 0 });
      }
      return Response.json({ message: path }, { status: 404 });
    },
  });
  stop = () => server.stop(true);
  const now = new Date();
  worker = db.insert(workers).values({
    id: crypto.randomUUID(),
    name: 'volume restore fixture',
    hostname: 'localhost',
    sshUser: 'root',
    podmanApiUrl: `http://127.0.0.1:${server.port}`,
    createdAt: now,
  }).returning().get();
});

afterEach(() => {
  if (runningId) db.delete(containers).where(eq(containers.containerId, runningId)).run();
  db.delete(applications).where(eq(applications.id, appId)).run();
  if (worker) {
    db.delete(workers).where(eq(workers.id, worker.id)).run();
    evictPodmanClient(worker.id);
  }
  stop();
});

function archive({ truncated = false } = {}) {
  const tar = buildTar([{ name: 'volume/data', content: 'incoming archive' }]);
  return new Response(new Uint8Array(truncated ? tar.subarray(0, 1024) : tar)).body!;
}

test('an archive extraction failure leaves the original volume and removes staging', async () => {
  failArchive = true;
  await expect(restoreVolume(worker, appId, target, archive(), 'replace')).rejects.toThrow('Existing contents were preserved');
  expect(store.get(target)?.contents).toBe('original');
  expect([...store.keys()]).toEqual([target, copy]);
});

test('an archive without the backup root leaves the original data alone', async () => {
  hasArchiveRoot = false;
  await expect(restoreVolume(worker, appId, target, archive(), 'replace')).rejects.toThrow('does not contain the volume/ directory');
  expect(store.get(target)?.contents).toBe('original');
});

test('a truncated archive cannot install even if the worker would accept the prefix', async () => {
  await expect(restoreVolume(worker, appId, target, archive({ truncated: true }), 'replace')).rejects.toThrow('Existing contents were preserved');
  expect(store.get(target)?.contents).toBe('original');
  expect([...store.keys()]).toEqual([target, copy]);
});

test('a failed read of the copy leaves the destination and source intact', async () => {
  failStaging = true;
  await expect(restoreFromCopy(worker, appId, copy, target)).rejects.toThrow('Existing contents were preserved');
  expect(store.get(target)?.contents).toBe('original');
  expect(store.get(copy)?.contents).toBe('replacement');
  expect([...store.keys()]).toEqual([target, copy]);
});

test('the final idle check can cancel a prepared restore before installation', async () => {
  const checkIdle = async () => {
    expect([...store.values()].some((volume) =>
      volume.Name !== target && volume.contents === 'original')).toBe(true);
    throw new Error('Workload started during staging');
  };
  await expect(restoreFromCopy(worker, appId, copy, target, checkIdle)).rejects.toThrow('Workload started during staging');
  expect(store.get(target)?.contents).toBe('original');
  expect([...store.keys()]).toEqual([target, copy]);
});

test('a failed install rolls the original data back in place', async () => {
  targetFailures = 1;
  const original = store.get(target);
  await expect(restoreFromCopy(worker, appId, copy, target)).rejects.toThrow('original contents were restored');
  expect(store.get(target)).toBe(original);
  expect(store.get(target)?.contents).toBe('original');
  expect([...store.keys()]).toEqual([target, copy]);
});

test('a failed rollback retains an identifiable copy of the original data', async () => {
  targetFailures = 2;
  const error = await restoreFromCopy(worker, appId, copy, target).catch((failure) => failure);
  expect(error.recoveryVolume).toBeString();
  expect(store.get(error.recoveryVolume)).toMatchObject({
    contents: 'original',
    Labels: { [COPY_SOURCE_LABEL]: target },
  });
  expect(store.get(copy)?.contents).toBe('replacement');
  expect(store.size).toBe(3);
});

test('a successful archive replace preserves the Podman volume and its labels', async () => {
  const original = store.get(target);
  await restoreVolume(worker, appId, target, archive(), 'replace');
  expect(store.get(target)).toBe(original);
  expect(store.get(target)).toMatchObject({ contents: 'incoming archive', Labels: { custom: 'keep' } });
  expect([...store.keys()]).toEqual([target, copy]);
});

test('copy restore refuses a live container when the cached status is exited', async () => {
  const now = new Date();
  runningId = crypto.randomUUID();
  db.insert(applications).values({
    id: appId,
    name: 'restore-guard-db',
    workerId: worker.id,
    type: 'compose',
    deploymentFormat: 'compose',
    manifest: 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - ./data:/data',
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(containers).values({
    id: crypto.randomUUID(),
    applicationId: appId,
    workerId: worker.id,
    containerId: runningId,
    image: 'postgres:16',
    name: 'live-database',
    status: 'exited',
    createdAt: now,
    updatedAt: now,
  }).run();

  const request = new Request(`http://localhost/api/applications/${appId}/volumes/${copy}/copy`, { method: 'PUT' });
  const response = await PUT({
    params: { id: appId, name: copy },
    url: new URL(request.url),
    request,
    locals: { auth: { user: { role: 'admin' } } },
  } as Parameters<typeof PUT>[0]);
  expect(response.status).toBe(409);
  expect((await response.json()).running).toEqual(['live-database']);
  expect(liveProbeWasLocked).toBe(true);
  expect(helperRequests).toBe(0);
});
