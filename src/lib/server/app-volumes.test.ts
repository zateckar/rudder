import { describe, expect, test } from 'bun:test';
import { buildAppStorage, type WorkerVolumeSnapshot } from './app-volumes';
import { desiredState } from './reconcile';
import { ManifestError } from './deploy/plan';
import { volumeCopyName } from './volumes';
import type { PodmanVolume } from './podman';
import type { applications, workers } from '$lib/db/schema';

/**
 * The point of these tests: the storage view has to be correct for all three
 * deployment formats, because the volume registry only ever covered one of them
 * and that is the bug. Each case runs a real manifest through the real
 * `desiredState` and asserts what comes out — so a parser change that moves a
 * volume's name is caught here rather than by someone finding an empty
 * application after a deploy.
 */

const APP_ID = 'abcdef12-3456-7890-abcd-ef1234567890';

function appRow(over: Partial<typeof applications.$inferSelect> = {}): typeof applications.$inferSelect {
  return {
    id: APP_ID,
    teamId: 'team-1',
    workerId: 'worker-1',
    name: 'shop',
    description: null,
    domain: null,
    type: 'single',
    deploymentFormat: 'compose',
    manifest: 'nginx:1.27',
    environment: null,
    volumes: null,
    restartPolicy: 'always',
    rateLimitAvg: null,
    rateLimitBurst: null,
    authType: 'global',
    authConfig: null,
    replicas: 1,
    gitRepo: null,
    gitBranch: null,
    gitDockerfile: null,
    healthcheck: null,
    healthTimeoutSeconds: null,
    retainPreviousMinutes: 0,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as typeof applications.$inferSelect;
}

function workerRow(): typeof workers.$inferSelect {
  return {
    id: 'worker-1',
    name: 'alpha',
    hostname: 'alpha.example.com',
    baseDomain: 'alpha.apps.example.com',
    status: 'online',
    routingMode: 'http',
  } as typeof workers.$inferSelect;
}

function podmanVolume(name: string): PodmanVolume {
  return { name, mountpoint: `/var/lib/containers/storage/volumes/${name}/_data`, createdAt: null, labels: {} };
}

function snapshot(entries: [string, number][]): WorkerVolumeSnapshot {
  return {
    volumes: entries.map(([name]) => podmanVolume(name)),
    usage: new Map(entries),
  };
}

/** Run the real planner, then the real fold. */
function storageFor(
  app: typeof applications.$inferSelect,
  options: {
    snapshot?: WorkerVolumeSnapshot | null;
    registry?: { id: string; podmanName: string; sizeLimit: number | null }[];
    volumeRegistry?: Map<string, { name: string; containerPath: string }>;
  } = {},
) {
  let desired = null;
  let manifestError: string | null = null;
  try {
    desired = desiredState({
      app,
      worker: workerRow(),
      team: { id: 'team-1', name: 'Shop', slug: 'shop' },
      volumeRegistry: options.volumeRegistry ?? new Map(),
    });
  } catch (e) {
    manifestError = e instanceof ManifestError ? e.message : String(e);
  }

  return buildAppStorage({
    appId: app.id,
    desired,
    manifestError,
    registry: options.registry ?? [],
    snapshot: options.snapshot === undefined ? snapshot([]) : options.snapshot,
    unreachable: null,
  });
}

describe('compose applications', () => {
  const COMPOSE = [
    'services:',
    '  web:',
    '    image: nginx:1.27',
    '    volumes:',
    '      - ./cache:/var/cache/nginx',
    '  db:',
    '    image: postgres:16',
    '    volumes:',
    '      - ./data:/var/lib/postgresql/data',
    '      - pgshared:/shared',
    '      - /srv/appdata/dumps:/dumps',
  ].join('\n');

  const app = appRow({ type: 'compose', manifest: COMPOSE });

  test('a relative source becomes a volume scoped to the service', () => {
    // This is the case the registry never covered: real Podman volumes holding
    // data across redeploys, with no row anywhere describing them.
    const storage = storageFor(app);
    const names = storage.volumes.map((v) => v.name);

    expect(names).toContain(`rudder-abcdef12-web-cache`);
    expect(names).toContain(`rudder-abcdef12-db-data`);
  });

  test('each service gets its own volume even for the same source', () => {
    const twice = appRow({
      type: 'compose',
      manifest: [
        'services:',
        '  a:',
        '    image: nginx:1.27',
        '    volumes: ["./data:/data"]',
        '  b:',
        '    image: nginx:1.27',
        '    volumes: ["./data:/data"]',
      ].join('\n'),
    });

    expect(storageFor(twice).volumes.map((v) => v.name)).toEqual([
      'rudder-abcdef12-a-data',
      'rudder-abcdef12-b-data',
    ]);
  });

  test('a volume named outright is not scoped to the application', () => {
    // `pgshared:/shared` produces a volume literally called `pgshared`, which
    // any other application naming it gets too. Flagged, because deleting it is
    // not a local decision — see the delete guard in the route.
    const shared = storageFor(app).volumes.find((v) => v.name === 'pgshared');
    expect(shared?.origin).toBe('shared');
  });

  test('an absolute source stays a host bind and is not offered as a volume', () => {
    const storage = storageFor(app);
    expect(storage.volumes.map((v) => v.name)).not.toContain('/srv/appdata/dumps');
    expect(storage.otherMounts).toContainEqual({
      kind: 'bind',
      source: '/srv/appdata/dumps',
      target: '/dumps',
      container: 'db',
    });
  });

  test('records which service mounts each volume, and where', () => {
    const data = storageFor(app).volumes.find((v) => v.name === 'rudder-abcdef12-db-data');
    expect(data?.targets).toEqual([
      { container: 'db', path: '/var/lib/postgresql/data', mode: 'rw' },
    ]);
  });
});

describe('single-container applications', () => {
  test('a registry reference resolves to its namespaced volume', () => {
    const app = appRow({
      volumes: JSON.stringify([{ volumeId: 'vol-1', mode: 'rw' }]),
    });

    const storage = storageFor(app, {
      volumeRegistry: new Map([['vol-1', { name: 'pgdata', containerPath: '/var/lib/data' }]]),
      registry: [{ id: 'vol-1', podmanName: 'rudder-abcdef12-pgdata', sizeLimit: 5_368_709_120 }],
    });

    expect(storage.volumes).toHaveLength(1);
    expect(storage.volumes[0]).toMatchObject({
      name: 'rudder-abcdef12-pgdata',
      label: 'pgdata',
      origin: 'registry',
      declared: true,
      registryId: 'vol-1',
      sizeLimit: 5_368_709_120,
    });
  });

  test('a host bind is reported but not treated as a volume', () => {
    const app = appRow({
      volumes: JSON.stringify([{ hostPath: '/srv/appdata/x', containerPath: '/x', mode: 'ro' }]),
    });

    const storage = storageFor(app);
    expect(storage.volumes).toEqual([]);
    expect(storage.otherMounts).toEqual([
      { kind: 'bind', source: '/srv/appdata/x', target: '/x', container: 'shop' },
    ]);
  });
});

describe('Kubernetes applications', () => {
  test('an emptyDir is a tmpfs, and a hostPath a bind — neither is a named volume', () => {
    const app = appRow({
      type: 'k8s',
      deploymentFormat: 'k8s',
      manifest: [
        'apiVersion: v1',
        'kind: Pod',
        'metadata:',
        '  name: shop',
        'spec:',
        '  containers:',
        '    - name: web',
        '      image: nginx:1.27',
        '      volumeMounts:',
        '        - name: scratch',
        '          mountPath: /scratch',
        '        - name: host',
        '          mountPath: /host',
        '  volumes:',
        '    - name: scratch',
        '      emptyDir: {}',
        '    - name: host',
        '      hostPath:',
        '        path: /srv/appdata/shop',
      ].join('\n'),
    });

    const storage = storageFor(app);
    expect(storage.volumes).toEqual([]);
    // Declaration order, as the container's `volumeMounts` list them.
    expect(storage.otherMounts).toEqual([
      { kind: 'tmpfs', source: null, target: '/scratch', container: 'web' },
      { kind: 'bind', source: '/srv/appdata/shop', target: '/host', container: 'web' },
    ]);
  });
});

describe('the worker\'s side of it', () => {
  const app = appRow({
    type: 'compose',
    manifest: ['services:', '  db:', '    image: postgres:16', '    volumes: ["./data:/data"]'].join('\n'),
  });

  test('a declared volume that exists carries its real size', () => {
    const storage = storageFor(app, {
      snapshot: snapshot([['rudder-abcdef12-db-data', 4096]]),
    });

    expect(storage.volumes[0]).toMatchObject({
      declared: true,
      present: true,
      sizeBytes: 4096,
    });
  });

  test('a declared volume not yet on the worker is present: false, not size 0', () => {
    // Podman creates a volume the first time a container mounts it, so a
    // declared-but-never-deployed volume is a real state — and reporting it as
    // 0 bytes would read as "deployed and empty".
    const storage = storageFor(app, { snapshot: snapshot([]) });
    expect(storage.volumes[0]).toMatchObject({ declared: true, present: false, sizeBytes: null });
  });

  test('an app-scoped volume nothing declares any more is still reported', () => {
    // The whole reason the leftover matters: it holds data and costs disk, and
    // before this there was nowhere in the UI it appeared at all.
    const storage = storageFor(app, {
      snapshot: snapshot([
        ['rudder-abcdef12-db-data', 4096],
        ['rudder-abcdef12-db-oldcache', 999],
      ]),
    });

    const leftover = storage.volumes.find((v) => v.name === 'rudder-abcdef12-db-oldcache');
    expect(leftover).toMatchObject({ declared: false, present: true, sizeBytes: 999 });
    // Declared volumes sort first, so the list does not lead with rubbish.
    expect(storage.volumes[0].declared).toBe(true);
  });

  test('another application\'s volumes are not listed', () => {
    const storage = storageFor(app, {
      snapshot: snapshot([['rudder-99999999-db-data', 1234], ['some-other-thing', 5]]),
    });
    expect(storage.volumes.map((v) => v.name)).toEqual(['rudder-abcdef12-db-data']);
  });

  test('copies attach to their source instead of appearing as strays', () => {
    const copy = volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 1_700_000_000_000);
    const storage = storageFor(app, {
      snapshot: snapshot([['rudder-abcdef12-db-data', 4096], [copy, 4000]]),
    });

    expect(storage.volumes.map((v) => v.name)).toEqual(['rudder-abcdef12-db-data']);
    expect(storage.volumes[0].copies).toEqual([
      { name: copy, at: 1_700_000_000_000, sizeBytes: 4000 },
    ]);
  });

  test('copies are newest first', () => {
    const older = volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 1_000);
    const newer = volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 2_000);
    const storage = storageFor(app, {
      snapshot: snapshot([['rudder-abcdef12-db-data', 1], [older, 1], [newer, 1]]),
    });

    expect(storage.volumes[0].copies.map((c) => c.name)).toEqual([newer, older]);
  });

  test('another application\'s copies are ignored', () => {
    const foreign = volumeCopyName('99999999-0000-0000-0000-000000000000', 'db-data', 1);
    const storage = storageFor(app, {
      snapshot: snapshot([['rudder-abcdef12-db-data', 1], [foreign, 1]]),
    });

    expect(storage.volumes).toHaveLength(1);
    expect(storage.volumes[0].copies).toEqual([]);
  });

  test('an unreachable worker leaves the declared list intact and the sizes unknown', () => {
    const storage = buildAppStorage({
      appId: APP_ID,
      desired: desiredState({
        app,
        worker: workerRow(),
        team: null,
        volumeRegistry: new Map(),
      }),
      manifestError: null,
      registry: [],
      snapshot: null,
      unreachable: 'Worker "alpha" could not be reached.',
    });

    expect(storage.volumes.map((v) => v.name)).toEqual(['rudder-abcdef12-db-data']);
    expect(storage.volumes[0].sizeBytes).toBeNull();
    expect(storage.unreachable).toContain('could not be reached');
  });
});

describe('a manifest that no longer parses', () => {
  test('reports the error and still lists what is on the worker', () => {
    // An application whose manifest broke is exactly the one whose leftover data
    // someone needs to reach, so the worker's side must not be withheld.
    const app = appRow({ type: 'compose', manifest: 'services: [this is not: valid: yaml' });
    const storage = storageFor(app, {
      snapshot: snapshot([['rudder-abcdef12-db-data', 8192]]),
    });

    expect(storage.manifestError).toBeTruthy();
    expect(storage.volumes).toHaveLength(1);
    expect(storage.volumes[0]).toMatchObject({ declared: false, sizeBytes: 8192 });
  });
});
