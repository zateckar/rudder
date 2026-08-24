import { describe, expect, test } from 'bun:test';
import {
  composeVolumeName,
  isAppScopedVolume,
  isCopyOfApp,
  isHostPathSource,
  parseVolumeCopyName,
  registryVolumeName,
  singleMountIntents,
  stripAppPrefix,
  volumeBaseName,
  volumeCopyBase,
  volumeCopyName,
  volumeOwnerApp8,
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

/**
 * Reading an owner back out of a name.
 *
 * This is what turns "the name proves nothing" into "the name says whose it is"
 * for every volume Rudder created, and it is the only ownership record there is:
 * a manifest can name any volume on the worker, and asking who *declares* a name
 * cannot see a neighbour's leftovers, a neighbour's copies, or anything at all
 * while the neighbour's manifest does not parse.
 */
describe('volumeOwnerApp8', () => {
  test('reads the owner out of each rule that embeds one', () => {
    expect(volumeOwnerApp8(composeVolumeName(APP_ID, 'db', 'data'))).toBe('abcdef12');
    expect(volumeOwnerApp8(registryVolumeName(APP_ID, 'pgdata'))).toBe('abcdef12');
    expect(volumeOwnerApp8(volumeCopyName(APP_ID, 'pgdata', 1_700_000_000_000))).toBe('abcdef12');
  });

  test('a name Rudder did not compose has no owner', () => {
    // Unowned, not everyone's: these fall to the "does anyone declare it" test.
    expect(volumeOwnerApp8('pgdata')).toBeNull();
    expect(volumeOwnerApp8('my-rudder-volume')).toBeNull();
    // No application segment — `composeVolumeName(null, …)`.
    expect(volumeOwnerApp8('rudder-db-data')).toBeNull();
    // Eight characters, but not hex, so not the shape an application id takes.
    expect(volumeOwnerApp8('rudder-zzzzzzzz-db-data')).toBeNull();
    // Eight hex digits and no separator: not a prefix either rule produces.
    expect(volumeOwnerApp8('rudder-abcdef12')).toBeNull();
  });

  test('a copy prefix cannot be mistaken for an application id', () => {
    // `o`, `p` and `y` are not hex digits, which is what keeps the two
    // namespaces apart — see `volumeCopyName`.
    expect(volumeOwnerApp8('rudder-copy-abcdef12-db-data-1700000000000')).toBe('abcdef12');
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

describe('copy names', () => {
  const OTHER_APP = '0badcafe-1111-2222-3333-444455556666';

  test('a copy is named after its source, its app and the moment it was taken', () => {
    expect(volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 1_700_000_000_000)).toBe(
      'rudder-copy-abcdef12-db-data-1700000000000',
    );
  });

  test('the application prefix is stripped before naming a copy', () => {
    // Otherwise the prefix appears twice and the name says nothing extra.
    expect(volumeCopyBase(APP_ID, 'rudder-abcdef12-pgdata')).toBe('pgdata');
    // A bare compose volume has no prefix to strip.
    expect(volumeCopyBase(APP_ID, 'pgdata')).toBe('pgdata');
  });

  test('a copy round-trips through its own name', () => {
    const name = volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 1_700_000_000_000);
    expect(parseVolumeCopyName(name)).toEqual({
      appId8: 'abcdef12',
      base: 'db-data',
      at: 1_700_000_000_000,
    });
  });

  test('the base is matched lazily, so the stamp keeps all of its digits', () => {
    // Greedily, a base of `db-data` and a stamp of 1700000000000 parse as a base
    // of `db-data-170000000000` and a stamp of 0 — and the copy then appears to
    // have been taken in 1970.
    expect(parseVolumeCopyName('rudder-copy-abcdef12-db-data-1700000000000')?.at).toBe(
      1_700_000_000_000,
    );
    // A base that itself ends in digits must not lose them either.
    expect(parseVolumeCopyName('rudder-copy-abcdef12-data2-1700000000000')).toEqual({
      appId8: 'abcdef12',
      base: 'data2',
      at: 1_700_000_000_000,
    });
    // Nor one containing a dash-digit segment.
    expect(parseVolumeCopyName('rudder-copy-abcdef12-v-1-1700000000000')).toEqual({
      appId8: 'abcdef12',
      base: 'v-1',
      at: 1_700_000_000_000,
    });
  });

  test('a copy is never mistaken for a volume an application runs on', () => {
    // The load-bearing property: `rudder-copy-` cannot collide with
    // `rudder-<app8>-`, because an application id is UUID hex and `o`, `p` and
    // `y` are not hex digits. Without this, a copy taken last week reads as a
    // stray volume to be cleaned away.
    const copy = volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 1_700_000_000_000);
    expect(isAppScopedVolume(copy, APP_ID)).toBe(false);
    expect(parseVolumeCopyName('rudder-abcdef12-db-data')).toBeNull();
  });

  test('a copy belongs to exactly one application', () => {
    const copy = volumeCopyName(APP_ID, 'rudder-abcdef12-db-data', 1);
    expect(isCopyOfApp(copy, APP_ID)).toBe(true);
    expect(isCopyOfApp(copy, OTHER_APP)).toBe(false);
  });

  test('anything that is not a copy name parses as null', () => {
    expect(parseVolumeCopyName('pgdata')).toBeNull();
    expect(parseVolumeCopyName('rudder-copy-')).toBeNull();
    // Eight hex digits exactly; a shorter id would make the split ambiguous.
    expect(parseVolumeCopyName('rudder-copy-abc-data-1')).toBeNull();
    // No stamp.
    expect(parseVolumeCopyName('rudder-copy-abcdef12-data')).toBeNull();
  });
});

describe('stripAppPrefix', () => {
  test('removes the prefix this application owns, and nothing else', () => {
    expect(stripAppPrefix(APP_ID, 'rudder-abcdef12-pgdata')).toBe('pgdata');
    // Another application's volume keeps its name: it is not ours to relabel.
    expect(stripAppPrefix(APP_ID, 'rudder-99999999-pgdata')).toBe('rudder-99999999-pgdata');
    expect(stripAppPrefix(APP_ID, 'pgdata')).toBe('pgdata');
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
