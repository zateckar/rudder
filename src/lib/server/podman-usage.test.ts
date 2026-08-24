import { describe, expect, test } from 'bun:test';
import { normalizeVolumeUsage, volumeUsageMap } from './podman';

/**
 * The 0-byte bug, pinned.
 *
 * `system/df` is the only place Podman reports volume disk usage, and the two
 * API routes spell the entry differently. Every reader — the worker detail page,
 * the metrics sweep, the collection endpoint — read Docker's spelling while
 * libpod is the route actually taken, so volume usage came out as 0 bytes on
 * every real worker while looking like a legitimate measurement.
 */
describe('normalizeVolumeUsage', () => {
  const LIBPOD = [
    { VolumeName: 'rudder-abcdef12-db-data', Links: 1, Size: 4096, ReclaimableSize: 4096 },
  ];
  const DOCKER = [{ Name: 'rudder-abcdef12-db-data', UsageData: { Size: 4096 } }];

  test('both spellings produce the same entry', () => {
    expect(normalizeVolumeUsage(LIBPOD)).toEqual(normalizeVolumeUsage(DOCKER));
    expect(normalizeVolumeUsage(LIBPOD)).toEqual([
      { Name: 'rudder-abcdef12-db-data', UsageData: { Size: 4096 } },
    ]);
  });

  test('libpod\'s flat Size is read, not silently dropped to zero', () => {
    // The assertion the bug would have failed.
    expect(normalizeVolumeUsage(LIBPOD)[0].UsageData.Size).toBe(4096);
  });

  test('a missing size is zero rather than undefined', () => {
    // Callers sum these; an undefined would turn one unmeasured volume into NaN
    // for the whole worker.
    expect(normalizeVolumeUsage([{ Name: 'x' }])).toEqual([
      { Name: 'x', UsageData: { Size: 0 } },
    ]);
  });

  test('a response with no volume section is an empty list, not a throw', () => {
    expect(normalizeVolumeUsage(undefined)).toEqual([]);
    expect(normalizeVolumeUsage(null)).toEqual([]);
    expect(normalizeVolumeUsage({})).toEqual([]);
  });
});

describe('volumeUsageMap', () => {
  test('keys sizes by volume name, from either spelling', () => {
    expect(
      volumeUsageMap({
        VolumesDiskUsage: [
          { VolumeName: 'a', Size: 10 },
          { Name: 'b', UsageData: { Size: 20 } },
        ],
      }),
    ).toEqual(new Map([['a', 10], ['b', 20]]));
  });

  test('an unnamed entry is skipped rather than keyed on the empty string', () => {
    expect(volumeUsageMap({ VolumesDiskUsage: [{ Size: 10 }] }).size).toBe(0);
  });

  test('a worker that reported nothing gives an empty map', () => {
    expect(volumeUsageMap(null).size).toBe(0);
    expect(volumeUsageMap({}).size).toBe(0);
  });
});
