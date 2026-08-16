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
