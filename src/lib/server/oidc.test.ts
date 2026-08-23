import { describe, expect, test } from 'bun:test';
import {
  OIDC_CALLBACK_PATH,
  generateOidcSecret,
  isValidCallbackPath,
  isValidOidcSecret,
  normalizeIssuerUrl,
  normalizeOidcSecret,
  oidcCallbackHost,
  oidcCallbackUrl,
  normalizeTokenHeader,
  resolveCallbackPath,
  tokenHeadersError,
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

describe('normalizeIssuerUrl', () => {
  test('strips the discovery path the plugin appends for itself', () => {
    // Found in production: a worker whose OIDC had never once worked. The
    // middleware loads and Traefik reports it healthy; the plugin only requests
    // the document on the first request that reaches it, and gets a 404 for
    // `…/.well-known/openid-configuration/.well-known/openid-configuration`.
    expect(
      normalizeIssuerUrl('https://identity.example.com/realms/standard/.well-known/openid-configuration'),
    ).toBe('https://identity.example.com/realms/standard');
  });

  test('leaves an issuer alone', () => {
    expect(normalizeIssuerUrl('https://identity.example.com/realms/standard')).toBe(
      'https://identity.example.com/realms/standard',
    );
    expect(normalizeIssuerUrl('https://accounts.google.com')).toBe('https://accounts.google.com');
  });

  test('drops trailing slashes, before and after the suffix', () => {
    for (const input of [
      'https://idp.example.com/realms/x/',
      'https://idp.example.com/realms/x///',
      'https://idp.example.com/realms/x/.well-known/openid-configuration/',
    ]) {
      expect(normalizeIssuerUrl(input)).toBe('https://idp.example.com/realms/x');
    }
  });

  test('matches the suffix case-insensitively', () => {
    expect(normalizeIssuerUrl('https://idp.example.com/x/.Well-Known/OpenID-Configuration')).toBe(
      'https://idp.example.com/x',
    );
  });

  test('trims surrounding whitespace from a pasted value', () => {
    expect(normalizeIssuerUrl('  https://idp.example.com/realms/x  ')).toBe(
      'https://idp.example.com/realms/x',
    );
  });

  test('returns null for nothing, so the column clears rather than storing ""', () => {
    for (const input of [null, undefined, '', '   ']) {
      expect(normalizeIssuerUrl(input)).toBeNull();
    }
  });

  test('does not strip a path that merely contains the suffix elsewhere', () => {
    const url = 'https://idp.example.com/.well-known/openid-configuration/realms/x';
    expect(normalizeIssuerUrl(url)).toBe(url);
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

  test('a worker s own path wins, so the URL matches what the IdP registered', () => {
    expect(oidcCallbackUrl('apps.example.com', '/oauth2/callback')).toBe(
      'https://auth.apps.example.com/oauth2/callback',
    );
  });
});

describe('callback path validation', () => {
  test('accepts ordinary absolute paths', () => {
    for (const path of ['/oidc/callback', '/oauth2/callback', '/', '/a-b_c.d~e/f%20g']) {
      expect(isValidCallbackPath(path)).toBe(true);
    }
  });

  test('rejects what would not survive as a redirect URI path', () => {
    // A query or fragment is dropped from the comparison the IdP makes, and a
    // relative path makes the plugin overlay the wrapped service instead of
    // using the shared auth host.
    for (const path of ['oidc/callback', '', '/cb?next=/', '/cb#frag', '/cb with space', 'https://elsewhere/cb']) {
      expect(isValidCallbackPath(path)).toBe(false);
    }
  });

  test('resolving falls back rather than propagating an unusable path', () => {
    // Reached by rows written before validation existed, or edited by hand.
    for (const input of [null, undefined, '', 'oidc/callback', '/cb?x=1']) {
      expect(resolveCallbackPath(input)).toBe(OIDC_CALLBACK_PATH);
    }
    expect(resolveCallbackPath('/oauth2/callback')).toBe('/oauth2/callback');
  });
});

describe('token header names', () => {
  test('not naming a header is how a token is not forwarded', () => {
    for (const input of [null, undefined, '', '   ']) {
      expect(normalizeTokenHeader(input)).toBeNull();
    }
    expect(tokenHeadersError(null, null)).toBeNull();
    expect(normalizeTokenHeader('  X-Token  ')).toBe('X-Token');
  });

  test('accepts the names an application would actually use', () => {
    expect(tokenHeadersError('X-Auth-Request-Id-Token', 'X-Auth-Request-Access-Token')).toBeNull();
    // The one name most applications already understand, and the reason the
    // renderer special-cases the Bearer prefix.
    expect(tokenHeadersError('Authorization', null)).toBeNull();
  });

  test('rejects anything that would not survive as YAML or as a header name', () => {
    // The value becomes a `Name:` in generated middleware configuration, so a
    // quote or a newline here would be a way to write arbitrary plugin config
    // through a form field.
    for (const bad of ['X Token', 'X:Token', 'X"Token', 'X\nName: evil', '1-Token', '-X', 'x'.repeat(65)]) {
      expect(tokenHeadersError(bad, null)).not.toBeNull();
    }
  });

  test('refuses to overwrite a header the proxy sets itself', () => {
    // The identity headers are set by the same middleware and the later
    // definition would win, replacing a username with a JWT.
    for (const reserved of ['X-Forwarded-User', 'x-forwarded-email', 'X-Forwarded-For', 'Host', 'Cookie']) {
      expect(tokenHeadersError(reserved, null)).not.toBeNull();
      expect(tokenHeadersError(null, reserved)).not.toBeNull();
    }
  });

  test('refuses the same name for both tokens', () => {
    // Which token the application received would otherwise depend on the order
    // the middleware happened to be rendered in.
    expect(tokenHeadersError('X-Token', 'x-token')).not.toBeNull();
  });
});
