import { describe, expect, test } from 'bun:test';
import {
  APP_ID_LABEL,
  MANAGED_LABEL,
  autoCorrectable,
  desiredState,
  diff,
  driftFingerprint,
  healthFromStatus,
  mayRemove,
  observedState,
  ownedAppId,
  permittedRemovals,
  podmanName,
  specHash,
  summarize,
  toObserved,
  type DriftEntry,
} from './reconcile';
import { ManifestError, type PlannedContainer } from './deploy/plan';
import type { applications, containers, workers } from '$lib/db/schema';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function appRow(over: Partial<typeof applications.$inferSelect> = {}): typeof applications.$inferSelect {
  return {
    id: 'app-1',
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
    stackId: null,
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

function containerRow(
  over: Partial<typeof containers.$inferSelect> = {},
): typeof containers.$inferSelect {
  return {
    id: 'row-1',
    applicationId: 'app-1',
    workerId: 'worker-1',
    containerId: 'abc123',
    name: 'shop-app-1',
    image: 'nginx:1.27',
    status: 'running',
    ports: null,
    exposedPort: null,
    domain: null,
    routerName: null,
    labels: null,
    generation: 1,
    deploymentId: 'dep-1',
    state: 'active',
    specHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as typeof containers.$inferSelect;
}

function workerRow(over: Partial<typeof workers.$inferSelect> = {}): typeof workers.$inferSelect {
  return {
    id: 'worker-1',
    name: 'alpha',
    hostname: 'alpha.example.com',
    baseDomain: 'alpha.apps.example.com',
    status: 'online',
    routingMode: 'http',
    ...over,
  } as typeof workers.$inferSelect;
}

/** The minimum a Podman list entry needs for these tests. */
function raw(over: Partial<Parameters<typeof toObserved>[0]> = {}) {
  return {
    Id: 'abc123',
    Names: ['/shop-1a2b3c4d'],
    Image: 'nginx:1.27',
    ImageID: 'sha256:aaa',
    Command: '',
    Created: 0,
    State: 'running',
    Status: 'Up 3 hours',
    Ports: [],
    Labels: { [MANAGED_LABEL]: 'true', [APP_ID_LABEL]: 'app-1' },
    ...over,
  } as Parameters<typeof toObserved>[0];
}

// ── The ownership rule ───────────────────────────────────────────────────────
//
// These are the most important tests in the file. Getting this wrong destroys a
// co-tenant's workload on a shared worker, and they would have done nothing to
// deserve it.

describe('mayRemove', () => {
  test('permits a container Rudder labelled as its own', () => {
    expect(mayRemove({ labels: { [MANAGED_LABEL]: 'true' } })).toBe(true);
  });

  test('refuses a container with no labels at all', () => {
    expect(mayRemove({ labels: {} })).toBe(false);
  });

  test('refuses a container labelled by something else', () => {
    // A co-tenant's workload. The `app` label is not ownership: app-discovery
    // used to infer applications from exactly this and would happily have
    // claimed it.
    expect(mayRemove({ labels: { app: 'shop', team: 'platform' } })).toBe(false);
  });

  test('refuses anything short of the exact marker', () => {
    for (const value of ['false', 'TRUE', '1', 'yes', '', 'true ']) {
      expect(mayRemove({ labels: { [MANAGED_LABEL]: value } })).toBe(false);
    }
  });

  test('survives a container whose labels are missing entirely', () => {
    // Podman omits `Labels` rather than sending `{}` for a container created
    // without any. An exception here would abort the whole reconcile pass.
    expect(mayRemove({} as any)).toBe(false);
    expect(mayRemove({ labels: undefined } as any)).toBe(false);
  });
});

describe('permittedRemovals', () => {
  test('never returns an unlabelled container', () => {
    const wanted: Array<{ name: string; labels: Record<string, string> }> = [
      { name: 'ours', labels: { [MANAGED_LABEL]: 'true' } },
      { name: 'theirs', labels: { app: 'someone-elses-postgres' } },
      { name: 'bare', labels: {} },
    ];
    expect(permittedRemovals(wanted).map((c) => c.name)).toEqual(['ours']);
  });

  test('is empty when nothing on the worker is ours', () => {
    // The first run against a worker Rudder has never deployed to. It must
    // propose destroying nothing at all.
    const foreign: Array<{ labels: Record<string, string> }> = [
      { labels: { app: 'traefik' } },
      { labels: { app: 'crowdsec' } },
      { labels: {} },
    ];
    expect(permittedRemovals(foreign)).toEqual([]);
  });
});

describe('ownedAppId', () => {
  test('reports the owning application', () => {
    expect(ownedAppId({ labels: { [MANAGED_LABEL]: 'true', [APP_ID_LABEL]: 'app-1' } })).toBe('app-1');
  });

  test('is null for a managed container that claims no application', () => {
    // Containers deployed after the managed label became unconditional but
    // before the app id was added.
    expect(ownedAppId({ labels: { [MANAGED_LABEL]: 'true' } })).toBeNull();
  });

  test('ignores an app id on an unmanaged container', () => {
    // Nothing stops a co-tenant setting this label. It confers no ownership
    // without the managed marker.
    expect(ownedAppId({ labels: { [APP_ID_LABEL]: 'app-1' } })).toBeNull();
  });
});

// ── Podman shapes ────────────────────────────────────────────────────────────

describe('podmanName', () => {
  test('strips the slash the compat API adds', () => {
    expect(podmanName('/shop-1a2b3c4d')).toBe('shop-1a2b3c4d');
    expect(podmanName('shop-1a2b3c4d')).toBe('shop-1a2b3c4d');
    expect(podmanName(undefined)).toBe('');
  });
});

describe('healthFromStatus', () => {
  test('reads health out of the status string', () => {
    // /containers/json carries no structured health field. Inspecting every
    // container to get one would be a round trip each, per worker, per cycle.
    expect(healthFromStatus('Up 2 minutes (healthy)')).toBe('healthy');
    expect(healthFromStatus('Up 5 seconds (unhealthy)')).toBe('unhealthy');
    expect(healthFromStatus('Up 1 second (health: starting)')).toBe('starting');
  });

  test('is null when the container declares no health check', () => {
    expect(healthFromStatus('Up 3 hours')).toBeNull();
    expect(healthFromStatus('Exited (0) 2 minutes ago')).toBeNull();
    expect(healthFromStatus(undefined)).toBeNull();
  });
});

describe('toObserved', () => {
  test('keeps only published host ports', () => {
    const observed = toObserved(
      raw({
        Ports: [
          { PrivatePort: 80, PublicPort: 31204, Type: 'tcp' },
          { PrivatePort: 9000, Type: 'tcp' },
        ],
      }),
    );
    expect(observed.hostPorts).toEqual([31204]);
  });

  test('defaults absent labels to an empty record', () => {
    expect(toObserved(raw({ Labels: undefined as any })).labels).toEqual({});
  });
});

// ── Spec hash ────────────────────────────────────────────────────────────────

function planned(over: Partial<PlannedContainer> = {}): PlannedContainer {
  return {
    key: 'web',
    name: 'shop-1a2b3c4d',
    image: 'nginx:1.27',
    env: ['LOG_LEVEL=info'],
    ports: { '80/tcp': [{ hostPort: '31204' }] },
    mounts: [],
    aliases: ['web', 'shop-web'],
    labels: { app: 'shop', [MANAGED_LABEL]: 'true' },
    restartPolicy: 'always',
    ...over,
  };
}

describe('specHash', () => {
  test('is stable across recomputation', () => {
    expect(specHash(planned())).toBe(specHash(planned()));
  });

  test('does not change when a rate limit changes', () => {
    // The whole reason the hash exists. Rate limits, auth mode and middleware
    // are served live to the worker in http routing mode, so an edit must not
    // make the reconciler want to rebuild a container that is running the right
    // bytes with the right environment.
    //
    // Structurally: none of that is in `PlannedContainer`. Routing labels are
    // stamped by the executor and the route itself is separate, so changing a
    // rate limit cannot reach this hash even by accident.
    const before = specHash(planned());
    const after = specHash(
      planned({ route: { domain: 'shop.example.com', routerName: 'shop', hostPort: 31204, definesRouter: true } }),
    );
    expect(after).toBe(before);
  });

  test('does not change when an allocated host port changes', () => {
    // Host ports come from an allocator, so recomputing an unchanged
    // application's plan yields different numbers. A hash containing them would
    // report the entire fleet stale on every single pass.
    const before = specHash(planned({ ports: { '80/tcp': [{ hostPort: '31204' }] } }));
    const after = specHash(planned({ ports: { '80/tcp': [{ hostPort: '31999' }] } }));
    expect(after).toBe(before);
  });

  test('changes when the image changes', () => {
    expect(specHash(planned({ image: 'nginx:1.28' }))).not.toBe(specHash(planned()));
  });

  test('changes when the environment changes', () => {
    expect(specHash(planned({ env: ['LOG_LEVEL=debug'] }))).not.toBe(specHash(planned()));
  });

  test('notices a reordered environment', () => {
    // Podman resolves a repeated variable to its last occurrence, so two orders
    // of the same pairs are two different environments. Sorting before hashing
    // would have called these equal.
    const a = specHash(planned({ env: ['A=1', 'A=2'] }));
    const b = specHash(planned({ env: ['A=2', 'A=1'] }));
    expect(a).not.toBe(b);
  });

  test('changes when storage changes', () => {
    const withVolume = planned({
      mounts: [{ kind: 'volume', name: 'rudder-1a2b3c4d-data', target: '/data', mode: 'rw' }],
    });
    expect(specHash(withVolume)).not.toBe(specHash(planned()));
    // Read-only is a different mount, and needs the container rebuilt to apply.
    const readOnly = planned({
      mounts: [{ kind: 'volume', name: 'rudder-1a2b3c4d-data', target: '/data', mode: 'ro' }],
    });
    expect(specHash(readOnly)).not.toBe(specHash(withVolume));
  });

  test('ignores the declaration order of storage', () => {
    // Two mounts on different paths do not interact, so the order they were
    // written in is not a difference worth rebuilding for.
    const a = planned({
      mounts: [
        { kind: 'volume', name: 'v1', target: '/a', mode: 'rw' },
        { kind: 'tmpfs', target: '/b' },
      ],
    });
    const b = planned({
      mounts: [
        { kind: 'tmpfs', target: '/b' },
        { kind: 'volume', name: 'v1', target: '/a', mode: 'rw' },
      ],
    });
    expect(specHash(a)).toBe(specHash(b));
  });

  test('changes when a resource limit changes', () => {
    expect(specHash(planned({ memory: 512 * 1024 * 1024 }))).not.toBe(specHash(planned()));
    expect(specHash(planned({ cpuQuota: 50_000, cpuPeriod: 100_000 }))).not.toBe(specHash(planned()));
  });

  test('changes when the command or entrypoint changes', () => {
    expect(specHash(planned({ command: ['--verbose'] }))).not.toBe(specHash(planned()));
    expect(specHash(planned({ entrypoint: ['/bin/sh', '-c', 'true'] }))).not.toBe(specHash(planned()));
  });

  test('changes when a delivered file changes content', () => {
    // Files are uploaded between create and start, so new content cannot reach a
    // running container. This has to force a new generation.
    const a = planned({ files: [{ dir: '/etc/app', name: 'config.yml', content: 'a: 1' }] });
    const b = planned({ files: [{ dir: '/etc/app', name: 'config.yml', content: 'a: 2' }] });
    expect(specHash(a)).not.toBe(specHash(b));
  });

  test('changes when the application is renamed', () => {
    // Identity labels and aliases both carry the name, and both need the
    // container rebuilt to change.
    const renamed = planned({ labels: { app: 'store', [MANAGED_LABEL]: 'true' }, aliases: ['web', 'store-web'] });
    expect(specHash(renamed)).not.toBe(specHash(planned()));
  });

  test('ignores the key order of labels', () => {
    const reordered = planned({ labels: { [MANAGED_LABEL]: 'true', app: 'shop' } });
    expect(specHash(reordered)).toBe(specHash(planned()));
  });
});

// ── Desired state ────────────────────────────────────────────────────────────

describe('desiredState', () => {
  test('is a pure function of the rows it is handed', () => {
    const app = appRow();
    const worker = workerRow();
    const a = desiredState({ app, worker });
    const b = desiredState({ app, worker });
    expect(a.containers.map((c) => c.specHash)).toEqual(b.containers.map((c) => c.specHash));
  });

  test('marks every container Rudder owns', () => {
    const desired = desiredState({ app: appRow(), worker: workerRow() });
    for (const c of desired.containers) {
      expect(c.planned.labels[MANAGED_LABEL]).toBe('true');
      expect(c.planned.labels[APP_ID_LABEL]).toBe('app-1');
      // The guard that gates every removal has to accept what a deploy creates,
      // or reconciliation could never clean up after itself.
      expect(mayRemove({ labels: c.planned.labels })).toBe(true);
    }
  });

  test('changing a rate limit does not change any specHash', () => {
    // The requirement this whole column exists for. An http-mode worker fetches
    // rate limits on a five-second poll, so editing one must not make the
    // reconciler want to rebuild a container that is running the right bytes.
    const before = desiredState({ app: appRow(), worker: workerRow() });
    const after = desiredState({
      app: appRow({ rateLimitAvg: 100, rateLimitBurst: 200, authType: 'oidc' }),
      worker: workerRow(),
    });
    expect(after.containers.map((c) => c.specHash)).toEqual(before.containers.map((c) => c.specHash));
  });

  test('changing the image does change the specHash', () => {
    const before = desiredState({ app: appRow(), worker: workerRow() });
    const after = desiredState({ app: appRow({ manifest: 'nginx:1.28' }), worker: workerRow() });
    expect(after.containers[0].specHash).not.toBe(before.containers[0].specHash);
  });

  test('changing the domain does not change the specHash', () => {
    // Routing is served live. Moving an application to a new hostname is a
    // configuration change the worker picks up on its next fetch.
    const before = desiredState({ app: appRow(), worker: workerRow() });
    const after = desiredState({ app: appRow({ domain: 'shop.example.com' }), worker: workerRow() });
    expect(after.containers[0].specHash).toBe(before.containers[0].specHash);
    expect(after.containers[0].planned.route?.domain).toBe('shop.example.com');
  });

  test('allocates nothing when no allocator is supplied', () => {
    // Reconciling is comparing, not deploying. If a reconcile pass drew real
    // ports it would reserve one for every application on every cycle.
    const compose = [
      'services:',
      '  web:',
      '    image: nginx:1.27',
      '    ports:',
      '      - "8080"',
    ].join('\n');
    const desired = desiredState({
      app: appRow({ type: 'compose', manifest: compose }),
      worker: workerRow(),
    });
    expect(desired.portsArePlaceholders).toBe(true);

    const real = desiredState({
      app: appRow({ type: 'compose', manifest: compose }),
      worker: workerRow(),
      allocatePort: () => 31234,
    });
    expect(real.portsArePlaceholders).toBe(false);
    expect(real.containers[0].planned.route?.hostPort).toBe(31234);
  });

  test('placeholder ports do not disturb the hash', () => {
    // Two passes over the same compose file hand out different placeholder
    // numbers if the counter advances. Neither may read as drift.
    const compose = [
      'services:',
      '  web:',
      '    image: nginx:1.27',
      '    ports:',
      '      - "8080"',
      '  api:',
      '    image: node:22',
      '    ports:',
      '      - "3000"',
    ].join('\n');
    const app = appRow({ type: 'compose', manifest: compose });
    const placeholders = desiredState({ app, worker: workerRow() });
    const allocated = desiredState({ app, worker: workerRow(), allocatePort: () => 31500 });
    expect(allocated.containers.map((c) => c.specHash)).toEqual(
      placeholders.containers.map((c) => c.specHash),
    );
  });

  test('refuses an application with no manifest', () => {
    expect(() => desiredState({ app: appRow({ manifest: null }), worker: workerRow() })).toThrow(
      ManifestError,
    );
  });

  test('reports a manifest it will not deploy as a ManifestError', () => {
    // A reconcile pass catches this per application. One unparseable manifest
    // must not blind the operator to drift on everything else on the worker.
    expect(() =>
      desiredState({ app: appRow({ type: 'compose', manifest: 'services: [' }), worker: workerRow() }),
    ).toThrow(ManifestError);
  });

  test('carries the notes the plan produced', () => {
    const twoContainers = [
      'apiVersion: v1',
      'kind: Pod',
      'metadata:',
      '  name: shop',
      'spec:',
      '  containers:',
      '    - name: web',
      '      image: nginx:1.27',
      '    - name: sidecar',
      '      image: busybox:1.36',
    ].join('\n');
    const desired = desiredState({
      app: appRow({ type: 'k8s', manifest: twoContainers }),
      worker: workerRow(),
    });
    expect(desired.containers).toHaveLength(2);
    expect(desired.notes.join(' ')).toContain('localhost');
  });
});

// ── Diff ─────────────────────────────────────────────────────────────────────

describe('diff', () => {
  /** A single-container application, deployed, running, and correct. */
  function healthy() {
    const desired = desiredState({ app: appRow(), worker: workerRow() });
    const want = desired.containers[0];
    const rows = [containerRow({ name: want.name, specHash: want.specHash })];
    const observed = [
      toObserved(raw({ Id: 'abc123', Names: [`/${want.name}`], Status: 'Up 3 hours' })),
    ];
    return { desired: [desired], rows, observed, knownAppIds: new Set(['app-1']), want };
  }

  test('reports nothing when reality matches intent', () => {
    const result = diff(healthy());
    expect(result.drift).toEqual([]);
    expect(result.clean).toBe(true);
  });

  test('a container removed by hand is missing', () => {
    const base = healthy();
    const result = diff({ ...base, observed: [] });
    expect(result.drift.map((d) => d.kind)).toEqual(['missing']);
    expect(result.drift[0].detail).toContain('recorded but not present');
    expect(result.clean).toBe(false);
  });

  test('a deploy that never created a container is missing', () => {
    // The partially failed deploy this plan exists to make self-healing: intent
    // names a container and no row was ever written for it.
    const base = healthy();
    const result = diff({ ...base, rows: [], observed: [] });
    expect(result.drift.map((d) => d.kind)).toEqual(['missing']);
    expect(result.drift[0].detail).toContain('failed partway through');
  });

  test('a container built from different configuration is stale', () => {
    const base = healthy();
    const rows = [containerRow({ name: base.want.name, specHash: 'a-hash-from-an-older-deploy' })];
    const result = diff({ ...base, rows });
    expect(result.drift.map((d) => d.kind)).toEqual(['stale']);
    expect(result.drift[0].containerId).toBe('abc123');
  });

  test('a container with no recorded hash is never stale', () => {
    // Deployed before the column existed, or adopted. Rudder does not know what
    // intent built it, and treating unknown as stale would propose rebuilding
    // every application on the first pass after the upgrade.
    const base = healthy();
    const result = diff({ ...base, rows: [containerRow({ name: base.want.name, specHash: null })] });
    expect(result.drift).toEqual([]);
  });

  test('a container failing its health check is unhealthy, not missing', () => {
    const base = healthy();
    const observed = [
      toObserved(raw({ Id: 'abc123', Names: [`/${base.want.name}`], Status: 'Up 5 minutes (unhealthy)' })),
    ];
    const result = diff({ ...base, observed });
    expect(result.drift.map((d) => d.kind)).toEqual(['unhealthy']);
  });

  test('a container that exited is missing rather than unhealthy', () => {
    // Different remedies: an unhealthy container is running and can be restarted
    // in place, an exited one has to be recreated.
    const base = healthy();
    const observed = [
      toObserved(
        raw({
          Id: 'abc123',
          Names: [`/${base.want.name}`],
          State: 'exited',
          Status: 'Exited (1) 2 minutes ago',
        }),
      ),
    ];
    const result = diff({ ...base, observed });
    expect(result.drift.map((d) => d.kind)).toEqual(['missing']);
    expect(result.drift[0].detail).toContain('exited');
  });

  test('an unmanaged container is foreign and does not make the worker dirty', () => {
    const base = healthy();
    const observed = [
      ...base.observed,
      toObserved(raw({ Id: 'traefik1', Names: ['/traefik'], Labels: { app: 'traefik' } })),
    ];
    const result = diff({ ...base, observed });
    expect(result.drift.map((d) => d.kind)).toEqual(['foreign']);
    // Foreign containers are information, not work. A worker with co-tenants
    // must not read as permanently drifted.
    expect(result.clean).toBe(true);
  });

  test('a co-tenant container is never classified as an orphan', () => {
    // The catastrophe this plan is guarding against. An unmanaged container has
    // no application, no row and no label, and every one of those could be read
    // as "unaccounted for" — but it is someone else's workload.
    const observed = [
      toObserved(raw({ Id: 'pg1', Names: ['/postgres'], Labels: {} })),
      toObserved(raw({ Id: 'redis1', Names: ['/redis'], Labels: { app: 'redis', team: 'other' } })),
    ];
    const result = diff({ desired: [], rows: [], observed, knownAppIds: new Set() });
    expect(result.drift.map((d) => d.kind)).toEqual(['foreign', 'foreign']);
    // And nothing about them can reach a removal, whatever the diff said.
    expect(permittedRemovals(observed)).toEqual([]);
  });

  test('a managed container Rudder has no record of is an orphan', () => {
    const observed = [
      toObserved(
        raw({
          Id: 'left1',
          Names: ['/deleted-app-9f8e7d6c'],
          Labels: { [MANAGED_LABEL]: 'true', [APP_ID_LABEL]: 'app-gone', app: 'deleted-app' },
        }),
      ),
    ];
    const result = diff({ desired: [], rows: [], observed, knownAppIds: new Set(['app-1']) });
    expect(result.drift.map((d) => d.kind)).toEqual(['orphan']);
    expect(result.drift[0].detail).toContain('no longer exists');
    expect(result.drift[0].appId).toBe('app-gone');
  });

  test('says so differently when the orphan belongs to an application that exists', () => {
    // Rudder lost the row rather than the user deleting the application. Same
    // classification, different remedy, so the message has to distinguish them.
    const observed = [
      toObserved(
        raw({ Id: 'left1', Names: ['/shop-1a2b3c4d'], Labels: { [MANAGED_LABEL]: 'true', [APP_ID_LABEL]: 'app-1' } }),
      ),
    ];
    const result = diff({ desired: [], rows: [], observed, knownAppIds: new Set(['app-1']) });
    expect(result.drift[0].kind).toBe('orphan');
    expect(result.drift[0].detail).toContain('has no record of it');
  });

  test('an application whose manifest stopped parsing loses no containers', () => {
    // The most dangerous shape in the whole design. `desiredState` throws, so the
    // application is absent from `desired` — and if orphan detection worked off
    // `desired` alone, every healthy container it owns would be proposed for
    // deletion because of a typo in a YAML file.
    const base = healthy();
    const result = diff({
      desired: [],
      rows: base.rows,
      observed: base.observed,
      knownAppIds: base.knownAppIds,
    });
    expect(result.drift).toEqual([]);
  });

  test('a retained previous generation is not drift', () => {
    // Blue/green keeps the superseded generation stopped-but-present for a fast
    // rollback. It is on the worker by design and absent from intent by design.
    const base = healthy();
    const rows = [
      ...base.rows,
      containerRow({
        id: 'row-old',
        containerId: 'old123',
        name: `${base.want.name}-g1`,
        state: 'draining',
        status: 'stopped',
        specHash: 'an-older-hash',
      }),
    ];
    const observed = [
      ...base.observed,
      toObserved(
        raw({
          Id: 'old123',
          Names: [`/${base.want.name}-g1`],
          State: 'exited',
          Status: 'Exited (0) 1 minute ago',
        }),
      ),
    ];
    const result = diff({ ...base, rows, observed });
    expect(result.drift).toEqual([]);
  });

  test('a running adopted container is not reported as missing', () => {
    // Found live on the user's fleet. Discovery writes the row with the leading
    // slash Podman's API sends; a deploy writes it without. The names then never
    // matched, so `uptime-kuma` — running, healthy, correct — reported NOT
    // RUNNING on every single pass.
    const base = healthy();
    const rows = [containerRow({ name: `/${base.want.name}` })];
    expect(diff({ ...base, rows }).drift).toEqual([]);
  });

  test('an adopted container with a name Rudder would never generate still matches', () => {
    // `/whoami` and `/demo-postgres-postgres`, also from the live fleet. The name
    // was chosen by whoever created the container, so no name rule can match it.
    // The row's application id is the authoritative link, and a null spec hash is
    // exactly the marker of a container Rudder did not build.
    const base = healthy();
    const rows = [containerRow({ name: '/whoami', specHash: null })];
    expect(diff({ ...base, rows }).drift).toEqual([]);
  });

  test('does not fall back positionally for a container Rudder built', () => {
    // A row with a hash came from a deploy, so its name matches one of the name
    // rules. Letting it be claimed by position would pair a renamed application's
    // containers with the wrong intent and report spurious staleness.
    const base = healthy();
    const rows = [containerRow({ name: 'something-else-entirely', specHash: 'a-real-hash' })];
    const result = diff({ ...base, rows });
    expect(result.drift.map((d) => d.kind)).toEqual(['missing']);
  });

  test('a tracked container is not also reported as foreign', () => {
    // An adopted container has a row but no managed label. Reporting it as "not
    // managed by Rudder" on the same page that lists it under the application is
    // simply untrue.
    const base = healthy();
    const rows = [containerRow({ name: `/${base.want.name}` })];
    const observed = [
      toObserved(raw({ Id: 'abc123', Names: [`/${base.want.name}`], Labels: { app: 'shop' } })),
    ];
    expect(diff({ ...base, rows, observed }).drift).toEqual([]);
  });

  test('but an untracked container is still never removable', () => {
    // Not reporting something as foreign must not be mistaken for permission to
    // delete it. The two decisions are independent, and only the label grants the
    // second.
    const tracked = toObserved(raw({ Id: 'abc123', Names: ['/adopted'], Labels: { app: 'shop' } }));
    expect(mayRemove(tracked)).toBe(false);
  });

  test('matches a blue/green name through its generation suffix', () => {
    const base = healthy();
    const rows = [
      containerRow({ name: `${base.want.name}-g4`, containerId: 'g4id', specHash: base.want.specHash }),
    ];
    const observed = [
      toObserved(raw({ Id: 'g4id', Names: [`/${base.want.name}-g4`], Status: 'Up 1 hour' })),
    ];
    expect(diff({ ...base, rows, observed }).drift).toEqual([]);
  });

  test('gives each replica its own row', () => {
    // Replicas of one application share a key and a spec hash, differing only by
    // name. Matching has to consume one row per desired container or the second
    // replica reads as missing while the first is counted twice.
    const desired = desiredState({ app: appRow({ replicas: 2 }), worker: workerRow() });
    expect(desired.containers).toHaveLength(2);
    const rows = desired.containers.map((c, i) =>
      containerRow({ id: `row-${i}`, containerId: `c${i}`, name: c.name, specHash: c.specHash }),
    );
    const observed = desired.containers.map((c, i) =>
      toObserved(raw({ Id: `c${i}`, Names: [`/${c.name}`], Status: 'Up 1 hour' })),
    );
    expect(diff({ desired: [desired], rows, observed, knownAppIds: new Set(['app-1']) }).drift).toEqual([]);
  });

  test('reports one replica missing when only one is running', () => {
    const desired = desiredState({ app: appRow({ replicas: 2 }), worker: workerRow() });
    const rows = [
      containerRow({ id: 'row-0', containerId: 'c0', name: desired.containers[0].name, specHash: desired.containers[0].specHash }),
    ];
    const observed = [toObserved(raw({ Id: 'c0', Names: [`/${desired.containers[0].name}`] }))];
    const result = diff({ desired: [desired], rows, observed, knownAppIds: new Set(['app-1']) });
    expect(result.drift.map((d) => d.kind)).toEqual(['missing']);
  });
});

// ── Report-only ──────────────────────────────────────────────────────────────

describe('observedState', () => {
  test('reads, and does nothing else', async () => {
    // The report-only guarantee, enforced rather than trusted. Every method but
    // `listContainers` throws, so touching one fails the test instead of a
    // worker.
    const calls: string[] = [];
    const readOnlyClient = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'listContainers') {
            return async () => {
              calls.push(prop);
              return [raw()];
            };
          }
          if (prop === 'then') return undefined; // not a promise
          return () => {
            throw new Error(`reconciliation must not call ${prop}`);
          };
        },
      },
    ) as any;

    const observed = await observedState(readOnlyClient);
    expect(observed).toHaveLength(1);
    expect(calls).toEqual(['listContainers']);
  });

  test('includes stopped containers', async () => {
    // A container that exited is drift. Listing only running ones would report it
    // as missing instead, which is a different remedy.
    const client = {
      listContainers: async (all: boolean) => {
        expect(all).toBe(true);
        return [raw({ State: 'exited', Status: 'Exited (0) 1 hour ago' })];
      },
    } as any;
    const observed = await observedState(client);
    expect(observed[0].state).toBe('exited');
  });
});

describe('autoCorrectable', () => {
  test('offers only the additive corrections', () => {
    // `stale` needs a running container replaced and `orphan` needs one deleted;
    // neither is additive, and neither may ever happen without a person. The
    // worst case of being wrong about `missing` or `unhealthy` is starting
    // something that did not need starting.
    const drift = (['missing', 'stale', 'unhealthy', 'orphan', 'foreign'] as const).map((kind) => ({
      kind,
      appId: 'app-1',
      appName: 'shop',
      name: `c-${kind}`,
      detail: '',
    }));
    expect(autoCorrectable(drift).map((d) => d.kind)).toEqual(['missing', 'unhealthy']);
  });
});

describe('driftFingerprint', () => {
  const entry = (over: Partial<DriftEntry> = {}): DriftEntry => ({
    kind: 'missing',
    appId: 'app-1',
    appName: 'shop',
    name: 'shop-1a2b3c4d',
    detail: 'Container is present but exited (Exited (1) 2 minutes ago).',
    ...over,
  });

  test('ignores the detail text', () => {
    // Details carry Podman's status string, which contains an uptime that ticks
    // upward. Hashing it would make every cycle look like new drift and notify
    // the operator every five minutes about one dead container.
    const a = driftFingerprint([entry()]);
    const b = driftFingerprint([entry({ detail: 'Container is present but exited (Exited (1) 9 hours ago).' })]);
    expect(a).toBe(b);
  });

  test('ignores the order findings were produced in', () => {
    const one = entry({ name: 'a' });
    const two = entry({ name: 'b' });
    expect(driftFingerprint([one, two])).toBe(driftFingerprint([two, one]));
  });

  test('changes when a new problem appears', () => {
    expect(driftFingerprint([entry(), entry({ name: 'another', kind: 'unhealthy' })])).not.toBe(
      driftFingerprint([entry()]),
    );
  });

  test('ignores foreign containers entirely', () => {
    // A co-tenant starting a container is not a change to Rudder's estate and
    // must not notify anyone.
    const withForeign = [entry(), entry({ kind: 'foreign', appId: null, name: 'postgres' })];
    expect(driftFingerprint(withForeign)).toBe(driftFingerprint([entry()]));
  });
});

describe('summarize', () => {
  test('counts by kind in a fixed order', () => {
    const drift: DriftEntry[] = [
      { kind: 'unhealthy', appId: null, appName: null, name: 'c', detail: '' },
      { kind: 'missing', appId: null, appName: null, name: 'a', detail: '' },
      { kind: 'missing', appId: null, appName: null, name: 'b', detail: '' },
    ];
    expect(summarize(drift)).toBe('2 missing, 1 unhealthy');
  });

  test('says so when there is nothing', () => {
    expect(summarize([])).toBe('nothing');
  });
});
