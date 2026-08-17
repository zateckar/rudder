import { describe, expect, test } from 'bun:test';
import { getPlatformVersions, versionFromLabels, versionsMatch } from './platform-versions';
import { PLATFORM_IMAGES } from './provisioning';
import type { PodmanClient } from './podman';

describe('versionFromLabels', () => {
  test('prefers the OCI version label', () => {
    expect(
      versionFromLabels({ 'org.opencontainers.image.version': 'v3.7.10' }, 'docker.io/traefik@sha256:abc'),
    ).toBe('v3.7.10');
  });

  test('accepts the older label-schema spelling', () => {
    expect(versionFromLabels({ 'org.label-schema.version': '1.7.8' }, null)).toBe('1.7.8');
  });

  test('falls back to the tag when the image carries no version label', () => {
    expect(versionFromLabels({}, 'docker.io/traefik:v3.7.10')).toBe('v3.7.10');
    expect(versionFromLabels(undefined, 'docker.io/crowdsecurity/crowdsec:v1.7.8')).toBe('v1.7.8');
  });

  test('a digest reference yields no version rather than a fake one', () => {
    // Reporting "sha256:abc…" as the running version would be worse than
    // admitting it is unknown.
    expect(versionFromLabels({}, 'docker.io/traefik@sha256:abcdef')).toBeNull();
  });

  test('a registry port is not mistaken for a tag', () => {
    expect(versionFromLabels({}, 'registry.example.com:5000/team/traefik')).toBeNull();
  });

  test('no labels and no reference is unknown', () => {
    expect(versionFromLabels(undefined, null)).toBeNull();
  });
});

describe('versionsMatch', () => {
  test('equal versions match', () => {
    expect(versionsMatch('v3.7.10', 'v3.7.10')).toBe(true);
  });

  test('a missing v prefix on either side still matches', () => {
    expect(versionsMatch('3.7.10', 'v3.7.10')).toBe(true);
    expect(versionsMatch('v3.7.10', '3.7.10')).toBe(true);
  });

  test('different versions do not match', () => {
    expect(versionsMatch('v3.6.25', 'v3.7.10')).toBe(false);
  });

  test('an unknown running version is null, not false', () => {
    // false would render as "upgrade available" for a worker nobody could read.
    expect(versionsMatch(null, 'v3.7.10')).toBeNull();
  });
});

describe('getPlatformVersions', () => {
  /**
   * A worker as provisioning leaves it: both containers created from a
   * digest-pinned reference. Traefik labels its image with a version; CrowdSec
   * does not, which is why it used to be the one reporting "unknown".
   */
  function fakeClient(): PodmanClient {
    return {
      listContainers: async () => [
        {
          Names: ['/traefik'],
          Image: `docker.io/${PLATFORM_IMAGES.traefik.repo}@sha256:aaa`,
          ImageID: 'sha256:aaa',
          Labels: {},
        },
        {
          Names: ['/crowdsec'],
          Image: `docker.io/${PLATFORM_IMAGES.crowdsec.repo}@sha256:bbb`,
          ImageID: 'sha256:bbb',
          Labels: {},
        },
      ],
      getImageJson: async (ref: string) =>
        ref === 'sha256:aaa'
          ? {
              Config: { Labels: { 'org.opencontainers.image.version': PLATFORM_IMAGES.traefik.version } },
              RepoTags: [`${PLATFORM_IMAGES.traefik.repo}:${PLATFORM_IMAGES.traefik.version}`],
            }
          : {
              // No version label at all — only the tag says which release this is.
              Config: { Labels: {} },
              RepoTags: [`${PLATFORM_IMAGES.crowdsec.repo}:${PLATFORM_IMAGES.crowdsec.version}`],
            },
    } as unknown as PodmanClient;
  }

  test('reads a version for an unlabelled image from its repo tag', async () => {
    const statuses = await getPlatformVersions(fakeClient());
    const crowdsec = statuses.find((s) => s.component === 'crowdsec')!;

    expect(crowdsec.runningVersion).toBe(PLATFORM_IMAGES.crowdsec.version);
    expect(crowdsec.upToDate).toBe(true);
    // The digest reference is still what gets reported as the running image.
    expect(crowdsec.runningImage).toContain('@sha256:');
  });

  test('still reads the labelled image the same way', async () => {
    const statuses = await getPlatformVersions(fakeClient());
    const traefik = statuses.find((s) => s.component === 'traefik')!;
    expect(traefik.runningVersion).toBe(PLATFORM_IMAGES.traefik.version);
    expect(traefik.upToDate).toBe(true);
  });

  test('a worker that cannot be listed reports unknown, not a guess', async () => {
    const dead = {
      listContainers: async () => { throw new Error('unreachable'); },
      getImageJson: async () => { throw new Error('unreachable'); },
    } as unknown as PodmanClient;

    for (const status of await getPlatformVersions(dead)) {
      expect(status.runningVersion).toBeNull();
      expect(status.upToDate).toBeNull();
    }
  });
});

describe('PLATFORM_IMAGES', () => {
  test('nothing floats on latest', () => {
    // The whole point of pinning: a floating tag turns an unrelated
    // re-provision into an unplanned upgrade.
    for (const [name, image] of Object.entries(PLATFORM_IMAGES)) {
      expect(image.version, `${name} must be pinned`).not.toBe('latest');
      expect(image.version).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });
});
