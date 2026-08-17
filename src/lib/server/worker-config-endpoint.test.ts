import { describe, expect, test } from 'bun:test';
import {
  checkPublicUrlReachable,
  configEndpointUrl,
  generateConfigToken,
} from './worker-config-endpoint';

describe('checkPublicUrlReachable', () => {
  test('accepts a public https URL', () => {
    expect(checkPublicUrlReachable('https://rudder.example.com')).toBeNull();
    expect(checkPublicUrlReachable('https://rudder.example.com:8443/')).toBeNull();
  });

  test('refuses loopback, which is what a dev control plane looks like', () => {
    // The failure this prevents is silent: the worker fetches nothing, serves
    // no routes, and a failed fetch looks like a control-plane blip.
    for (const url of [
      'http://localhost:7244',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://rudder.localhost',
    ]) {
      expect(checkPublicUrlReachable(url), url).toMatch(/cannot reach/);
    }
  });

  test('refuses plain http, because the config carries a bearer token', () => {
    const error = checkPublicUrlReachable('http://rudder.example.com');
    expect(error).toMatch(/must be https/);
    // Loopback is reported first — it is the more fundamental problem.
    expect(checkPublicUrlReachable('http://localhost:7244')).toMatch(/cannot reach/);
  });

  test('refuses something that is not a URL at all', () => {
    expect(checkPublicUrlReachable('not a url')).toMatch(/not a valid URL/);
    expect(checkPublicUrlReachable('')).toMatch(/not a valid URL/);
  });
});

describe('configEndpointUrl', () => {
  test('builds the path the worker fetches', () => {
    expect(configEndpointUrl('abc-123', 'https://rudder.example.com')).toBe(
      'https://rudder.example.com/api/workers/abc-123/traefik-config',
    );
  });

  test('does not double the slash when PUBLIC_URL has a trailing one', () => {
    expect(configEndpointUrl('abc-123', 'https://rudder.example.com///')).toBe(
      'https://rudder.example.com/api/workers/abc-123/traefik-config',
    );
  });
});

describe('generateConfigToken', () => {
  test('is 32 bytes of hex', () => {
    expect(generateConfigToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateConfigToken()));
    expect(tokens.size).toBe(50);
  });
});
