import { describe, expect, test } from 'bun:test';
import {
  APP_ID_LABEL,
  MANAGED_LABEL,
  healthFromStatus,
  mayRemove,
  ownedAppId,
  permittedRemovals,
  podmanName,
  specHash,
  toObserved,
} from './reconcile';
import type { PlannedContainer } from './deploy/plan';

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
