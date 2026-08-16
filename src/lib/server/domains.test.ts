import { describe, expect, test } from 'bun:test';
import { buildAppDomain, buildServiceDomain, routerName, toDnsLabel } from './domains';

describe('toDnsLabel', () => {
  test('lowercases', () => {
    expect(toDnsLabel('MyApp')).toBe('myapp');
  });

  test('collapses runs of invalid characters into a single hyphen', () => {
    expect(toDnsLabel('my app')).toBe('my-app');
    expect(toDnsLabel('my   app')).toBe('my-app');
    expect(toDnsLabel('my_app.v2')).toBe('my-app-v2');
  });

  test('strips leading and trailing hyphens', () => {
    expect(toDnsLabel('--foo--')).toBe('foo');
    expect(toDnsLabel('.foo.')).toBe('foo');
  });

  test('drops non-ascii rather than emitting it into a hostname', () => {
    expect(toDnsLabel('café')).toBe('caf');
    expect(toDnsLabel('日本語')).toBe('');
  });

  test('truncates to the 63-character DNS label limit', () => {
    expect(toDnsLabel('a'.repeat(70))).toHaveLength(63);
  });

  test('truncation never leaves a trailing hyphen', () => {
    // Cutting at 63 lands exactly on the hyphen; an unstripped result would be
    // an invalid DNS label and Let's Encrypt would refuse to issue for it.
    const value = `${'a'.repeat(62)}-bbbb`;
    const label = toDnsLabel(value);
    expect(label).toBe('a'.repeat(62));
    expect(label.endsWith('-')).toBe(false);
  });

  test('yields an empty label when nothing usable remains', () => {
    expect(toDnsLabel('---')).toBe('');
    expect(toDnsLabel('')).toBe('');
  });
});

describe('buildAppDomain', () => {
  test('is <app>.<baseDomain>, with no team segment', () => {
    expect(buildAppDomain('grafana', 'apps.example.com')).toBe('grafana.apps.example.com');
  });

  test('normalises the app name into the hostname', () => {
    expect(buildAppDomain('My App', 'apps.example.com')).toBe('my-app.apps.example.com');
  });

  test('returns null without a base domain', () => {
    expect(buildAppDomain('grafana', null)).toBeNull();
    expect(buildAppDomain('grafana', undefined)).toBeNull();
    expect(buildAppDomain('grafana', '')).toBeNull();
  });

  test('returns null rather than a bare dot-prefixed host for an unusable name', () => {
    expect(buildAppDomain('---', 'apps.example.com')).toBeNull();
  });
});

describe('buildServiceDomain', () => {
  test('disambiguates secondary services inside one label', () => {
    expect(buildServiceDomain('shop', 'api', 'apps.example.com')).toBe('shop-api.apps.example.com');
  });

  test('collapses to the app hostname when the service shares the app name', () => {
    expect(buildServiceDomain('shop', 'shop', 'apps.example.com')).toBe('shop.apps.example.com');
  });

  test('collapses to the app hostname when the service name is unusable', () => {
    expect(buildServiceDomain('shop', '', 'apps.example.com')).toBe('shop.apps.example.com');
    expect(buildServiceDomain('shop', '///', 'apps.example.com')).toBe('shop.apps.example.com');
  });

  test('returns null without a base domain', () => {
    expect(buildServiceDomain('shop', 'api', null)).toBeNull();
  });
});

describe('routerName', () => {
  test('matches the hostname label for the primary route', () => {
    expect(routerName('My App')).toBe('my-app');
    expect(buildAppDomain('My App', 'x.com')).toBe(`${routerName('My App')}.x.com`);
  });

  test('matches the hostname label for secondary services', () => {
    expect(routerName('shop', 'api')).toBe('shop-api');
    expect(buildServiceDomain('shop', 'api', 'x.com')).toBe(`${routerName('shop', 'api')}.x.com`);
  });

  test('collapses a service equal to the app name, like the hostname does', () => {
    expect(routerName('shop', 'shop')).toBe('shop');
  });

  test('distinguishes the same service name across different apps', () => {
    // Two apps each with a "web" service must not collide on one Traefik router.
    expect(routerName('shop', 'web')).not.toBe(routerName('blog', 'web'));
  });
});
