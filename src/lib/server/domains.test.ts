import { describe, expect, test } from 'bun:test';
import {
  buildAppDomain,
  buildServiceDomain,
  domainFormatError,
  routerName,
  toDnsLabel,
} from './domains';

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

describe('domainFormatError', () => {
  test('accepts ordinary hostnames', () => {
    for (const domain of [
      'example.com',
      'app.example.com',
      'my-app.apps.example.com',
      'a.b.c.d.example.com',
      'localhost',
      'x1.example.com',
    ]) {
      expect(domainFormatError(domain), domain).toBeNull();
    }
  });

  test('accepts everything buildAppDomain produces', () => {
    // The generated path and the user-supplied path share this validator, so a
    // canonical hostname must never be rejected by it.
    expect(domainFormatError(buildAppDomain('My App', 'apps.example.com')!)).toBeNull();
    expect(domainFormatError(buildServiceDomain('shop', 'api', 'apps.example.com')!)).toBeNull();
  });

  test('rejects a backtick, which closes the Traefik matcher', () => {
    // The whole point. ``Host(`<domain>`)`` is parsed by Traefik as an
    // expression, so a backtick ends the hostname and everything after it is
    // rule logic — here, a second router for a host the caller does not own,
    // longer than the victim's rule and therefore higher priority.
    const injected = 'a.example.com`) || Host(`victim.example.com';
    const error = domainFormatError(injected);
    expect(error).toContain('illegal character');
    expect(error).toContain('`');
  });

  test('rejects the rest of the Traefik rule grammar', () => {
    for (const domain of [
      'a.example.com) || Host(b.example.com',
      'a.example.com && PathPrefix(/x)',
      "a.example.com'",
      'a.example.com"',
      'a b.example.com',
      'a.example.com\tb',
    ]) {
      expect(domainFormatError(domain), domain).not.toBeNull();
    }
  });

  test('rejects malformed hostnames', () => {
    expect(domainFormatError('')).toContain('required');
    expect(domainFormatError('   ')).toContain('required');
    expect(domainFormatError('a..example.com')).toContain('empty label');
    expect(domainFormatError('.example.com')).toContain('empty label');
    expect(domainFormatError('example.com.')).toContain('empty label');
    expect(domainFormatError('-a.example.com')).toContain('not a valid hostname label');
    expect(domainFormatError('a-.example.com')).toContain('not a valid hostname label');
    expect(domainFormatError('a_b.example.com')).toContain('not a valid hostname label');
    expect(domainFormatError(`${'a'.repeat(64)}.example.com`)).toContain('not a valid hostname label');
  });

  test('rejects surrounding whitespace instead of silently trimming it', () => {
    // Callers store the value as given, so accepting a trimmed copy would write
    // the spaces and produce a router rule that matches nothing.
    expect(domainFormatError(' app.example.com')).not.toBeNull();
    expect(domainFormatError('app.example.com ')).not.toBeNull();
    expect(domainFormatError('app.example.com\n')).not.toBeNull();
  });

  test('rejects an over-long hostname', () => {
    const long = `${Array.from({ length: 40 }, () => 'abcdef').join('.')}.example.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(domainFormatError(long)).toContain('too long');
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
