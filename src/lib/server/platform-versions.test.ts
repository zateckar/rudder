import { describe, expect, test } from 'bun:test';
import { versionFromLabels, versionsMatch } from './platform-versions';
import { PLATFORM_IMAGES } from './provisioning';

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
