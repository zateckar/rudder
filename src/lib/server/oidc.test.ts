import { describe, expect, test } from 'bun:test';
import {
  OIDC_CALLBACK_PATH,
  generateOidcSecret,
  isValidOidcSecret,
  normalizeOidcSecret,
  oidcCallbackHost,
  oidcCallbackUrl,
} from './oidc';

describe('generateOidcSecret', () => {
  test('is always exactly 32 characters', () => {
    // The plugin uses this value directly as an AES-256 key. Any other length
    // makes the middleware fail to build, which makes Traefik discard the whole
    // dynamic config file — taking every route on the worker with it.
    for (let i = 0; i < 200; i++) {
      expect(generateOidcSecret()).toHaveLength(32);
    }
  });

  test('is hex, so it survives YAML and label round-trips unquoted', () => {
    expect(generateOidcSecret()).toMatch(/^[0-9a-f]{32}$/);
  });

  test('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateOidcSecret()));
    expect(seen.size).toBe(100);
  });
});

describe('isValidOidcSecret', () => {
  test('accepts exactly 32 characters', () => {
    expect(isValidOidcSecret('a'.repeat(32))).toBe(true);
  });

  test('rejects every other length, including the legacy 64-char format', () => {
    for (const length of [0, 1, 31, 33, 64]) {
      expect(isValidOidcSecret('a'.repeat(length))).toBe(false);
    }
  });

  test('rejects null and undefined', () => {
    expect(isValidOidcSecret(null)).toBe(false);
    expect(isValidOidcSecret(undefined)).toBe(false);
  });
});

describe('normalizeOidcSecret', () => {
  test('passes a valid secret through untouched', () => {
    // Must be stable: rotating on every apply would sign every user out each
    // time the config is pushed.
    const secret = 'b'.repeat(32);
    expect(normalizeOidcSecret(secret)).toEqual({ secret, rotated: false });
  });

  test('rotates the legacy 64-character key', () => {
    const result = normalizeOidcSecret('c'.repeat(64));
    expect(result.rotated).toBe(true);
    expect(result.secret).toHaveLength(32);
  });

  test('generates one when absent', () => {
    for (const input of [null, undefined, '']) {
      const result = normalizeOidcSecret(input);
      expect(result.rotated).toBe(true);
      expect(result.secret).toHaveLength(32);
    }
  });
});

describe('callback addressing', () => {
  test('the callback host is what needs a DNS A record', () => {
    expect(oidcCallbackHost('apps.example.com')).toBe('auth.apps.example.com');
  });

  test('the callback URL is the single redirect URI to register with the IdP', () => {
    expect(oidcCallbackUrl('apps.example.com')).toBe('https://auth.apps.example.com/oidc/callback');
  });

  test('the URL is the host plus the shared path', () => {
    const base = 'apps.example.com';
    expect(oidcCallbackUrl(base)).toBe(`https://${oidcCallbackHost(base)}${OIDC_CALLBACK_PATH}`);
  });

  test('the path is the plugin default, not the previous plugin s', () => {
    // The old lukaszraczylo plugin used /oauth2/callback; changing this silently
    // would break every registered redirect URI.
    expect(OIDC_CALLBACK_PATH).toBe('/oidc/callback');
  });
});
