import { describe, expect, test } from 'bun:test';
import {
  composeVolumeName,
  isHostPathSource,
  registryVolumeName,
  singleMountIntents,
  volumeBaseName,
} from './volumes';

const APP_ID = 'abcdef12-3456-7890-abcd-ef1234567890';

describe('volume naming', () => {
  // These two rules are load-bearing: the name is the only thing tying a
  // running application to the data it wrote last week. The assertions are
  // byte-exact on purpose — a "tidier" name orphans every existing volume.
  test('compose scopes a volume to its service', () => {
    expect(composeVolumeName(APP_ID, 'db', 'data')).toBe('rudder-abcdef12-db-data');
  });

  test('the registry scopes a volume to its application', () => {
    expect(registryVolumeName(APP_ID, 'pgdata')).toBe('rudder-abcdef12-pgdata');
  });

  test('compose falls back to an unscoped prefix with no application id', () => {
    expect(composeVolumeName(undefined, 'db', 'data')).toBe('rudder-db-data');
  });
});

describe('volumeBaseName', () => {
  test('strips path prefixes and the characters Podman will not take', () => {
    expect(volumeBaseName('./data', '/x')).toBe('data');
    expect(volumeBaseName('~/var/cache', '/x')).toBe('var-cache');
    expect(volumeBaseName('', '/var/lib/postgresql/data')).toBe('var-lib-postgresql-data');
  });

  test('never returns an empty name', () => {
    expect(volumeBaseName('./', '/')).toBe('vol');
  });
});

describe('isHostPathSource', () => {
  test('only an absolute path is a bind mount', () => {
    expect(isHostPathSource('/srv/data')).toBe(true);
    expect(isHostPathSource('pgdata')).toBe(false);
    // Relative sources resolve against the control plane, not the worker.
    expect(isHostPathSource('./data')).toBe(false);
    expect(isHostPathSource('~/data')).toBe(false);
  });
});

describe('singleMountIntents', () => {
  const registry = new Map([['v1', { name: 'pgdata', containerPath: '/var/lib/data' }]]);

  test('resolves a registered volume to its namespaced name', () => {
    const raw = JSON.stringify([{ volumeId: 'v1', mode: 'rw' }]);
    expect(singleMountIntents(APP_ID, raw, registry)).toEqual([
      { kind: 'volume', name: 'rudder-abcdef12-pgdata', target: '/var/lib/data', mode: 'rw' },
    ]);
  });

  test('emits a host path as a bind, leaving policy to the executor', () => {
    const raw = JSON.stringify([{ hostPath: '/srv/x', containerPath: '/x', mode: 'ro' }]);
    expect(singleMountIntents(APP_ID, raw, registry)).toEqual([
      { kind: 'bind', source: '/srv/x', target: '/x', mode: 'ro' },
    ]);
  });

  test('emits a non-absolute source as a named volume, not a bind', () => {
    // What adoption records for `pg-data:/var/lib/postgresql/data:rw`. Read as a
    // bind this reached `buildHostBind`, which rejected it for not being
    // absolute, and the application could not be redeployed at all.
    const raw = JSON.stringify([
      { hostPath: 'pg-data', containerPath: '/var/lib/postgresql/data', mode: 'rw' },
    ]);
    expect(singleMountIntents(APP_ID, raw, registry)).toEqual([
      { kind: 'volume', name: 'pg-data', target: '/var/lib/postgresql/data', mode: 'rw' },
    ]);
  });

  test('mounts a named volume under its literal name', () => {
    // Namespacing it would create a new empty volume on the next deploy and
    // orphan the data the adopted container is serving from right now.
    const raw = JSON.stringify([{ hostPath: 'pg-data', containerPath: '/data' }]);
    const [intent] = singleMountIntents(APP_ID, raw, registry);
    expect(intent).toMatchObject({ kind: 'volume', name: 'pg-data' });
    expect((intent as { name: string }).name).not.toContain('rudder-');
  });

  test('treats a relative or ~ source as a volume too, never a bind', () => {
    const raw = JSON.stringify([
      { hostPath: './data', containerPath: '/a' },
      { hostPath: '~/cache', containerPath: '/b' },
    ]);
    // Bound literally these would resolve against the control plane's working
    // directory, which is not where the container runs.
    expect(singleMountIntents(APP_ID, raw, registry).map((i) => i.kind)).toEqual([
      'volume',
      'volume',
    ]);
  });

  test('a registry reference still wins over the source beside it', () => {
    // `VolumeMountEditor` fills `hostPath` with the registered volume's name
    // when one is picked, and that name must not be mounted as-is — the
    // registry rule namespaces it per application.
    const raw = JSON.stringify([{ volumeId: 'v1', hostPath: 'pgdata', containerPath: '/x' }]);
    expect(singleMountIntents(APP_ID, raw, registry)).toEqual([
      { kind: 'volume', name: 'rudder-abcdef12-pgdata', target: '/var/lib/data', mode: 'rw' },
    ]);
  });

  test('drops a reference to a volume that has been deleted', () => {
    const raw = JSON.stringify([{ volumeId: 'gone' }]);
    expect(singleMountIntents(APP_ID, raw, registry)).toEqual([]);
  });

  test('drops an incomplete host mount', () => {
    const raw = JSON.stringify([{ hostPath: '/srv/x' }, { containerPath: '/x' }]);
    expect(singleMountIntents(APP_ID, raw, registry)).toEqual([]);
  });

  test('survives an unusable volumes column', () => {
    expect(singleMountIntents(APP_ID, null, registry)).toEqual([]);
    expect(singleMountIntents(APP_ID, '{not json', registry)).toEqual([]);
    expect(singleMountIntents(APP_ID, '{"a":1}', registry)).toEqual([]);
  });

  test('defaults the mode to read-write', () => {
    const raw = JSON.stringify([{ hostPath: '/srv/x', containerPath: '/x' }]);
    expect(singleMountIntents(APP_ID, raw, registry)[0]).toMatchObject({ mode: 'rw' });
  });
});
