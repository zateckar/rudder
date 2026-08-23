import { describe, expect, test } from 'bun:test';
import { assertDistinctAliases, networkAliases } from './networks';

describe('networkAliases', () => {
  test('gives a service its bare name and a qualified one', () => {
    // The bare name is what a compose file or a Kubernetes manifest already
    // writes; the qualified one stays stable however the service is spelled.
    expect(networkAliases('shop', 'db')).toEqual(['db', 'shop-db']);
  });

  test('collapses to one name when the container is the application', () => {
    // A single-container app would otherwise answer to `shop` and `shop-shop`.
    expect(networkAliases('shop', 'shop')).toEqual(['shop']);
  });

  test('normalises both names to DNS labels', () => {
    expect(networkAliases('My Shop', 'Web_API')).toEqual(['web-api', 'my-shop-web-api']);
  });

  test('falls back to the application name when the key is unusable', () => {
    expect(networkAliases('shop', '___')).toEqual(['shop']);
  });
});

describe('assertDistinctAliases', () => {
  test('accepts distinct names', () => {
    expect(() => assertDistinctAliases('shop', ['web', 'db', 'cache'])).not.toThrow();
  });

  test('refuses two containers with the same name', () => {
    // Legal in Kubernetes across two Deployments, impossible on one network.
    expect(() => assertDistinctAliases('shop', ['web', 'web'])).toThrow(/both named "web"/);
  });

  test('refuses names that differ only outside the DNS alphabet', () => {
    // `my_db` and `my-db` are two services in a compose file and one alias
    // here, which Podman resolves to whichever container it feels like.
    expect(() => assertDistinctAliases('shop', ['my_db', 'my-db'])).toThrow(
      /both resolve to the network alias "my-db"/,
    );
  });

  test('refuses two unusable names, which both fall back to the app', () => {
    expect(() => assertDistinctAliases('shop', ['...', '___'])).toThrow(/network alias "shop"/);
  });
});
