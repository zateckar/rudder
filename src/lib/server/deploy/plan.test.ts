/**
 * Route assignment — the last point before a hostname becomes a Traefik rule.
 *
 * `createRouteAssigner` decides the hostname each container is reached on, and
 * that value is interpolated into ``Host(`…`)`` by
 * `generateTraefikLabelsForApp`. Traefik parses a rule as an expression, so the
 * interior has to be a hostname and nothing else — which makes this function,
 * not the forms that write `applications.domain`, the place the guarantee has to
 * hold. The forms cannot vouch for a row they did not write.
 */
import { describe, expect, test } from 'bun:test';
import { ManifestError, createRouteAssigner, type PlanContext } from './plan';

function ctxFor(overrides: Partial<PlanContext> = {}): PlanContext {
  let next = 31000;
  return {
    appId: '11111111-2222-3333-4444-555555555555',
    appName: 'shop',
    baseDomain: 'apps.example.com',
    allocatePort: () => next++,
    ...overrides,
  };
}

describe('createRouteAssigner — hostnames', () => {
  test('the first port owns the application hostname', () => {
    const assign = createRouteAssigner(ctxFor());
    expect(assign('web', 31000).domain).toBe('shop.apps.example.com');
  });

  test('later services are disambiguated inside the same label', () => {
    const assign = createRouteAssigner(ctxFor());
    assign('web', 31000);
    expect(assign('api', 31001).domain).toBe('shop-api.apps.example.com');
  });

  test('an explicit domain wins over the generated one', () => {
    const assign = createRouteAssigner(ctxFor({ appDomain: 'shop.example.net' }));
    expect(assign('web', 31000).domain).toBe('shop.example.net');
  });

  test('normalises the fallback when there is no base domain', () => {
    // The fallback used to be the raw application name, which is not a hostname:
    // "My Shop" would have been interpolated into a Host() rule with a space in
    // it. It goes through toDnsLabel now, like routerName already did.
    const assign = createRouteAssigner(ctxFor({ appName: 'My Shop', baseDomain: null }));
    const route = assign('web', 31000);
    expect(route.domain).toBe('my-shop');
    expect(route.routerName).toBe('my-shop-11111111');
  });

  test('normalises the secondary fallback too', () => {
    const assign = createRouteAssigner(ctxFor({ appName: 'My Shop', baseDomain: null }));
    assign('web', 31000);
    expect(assign('API v2', 31001).domain).toBe('my-shop-api-v2');
  });
});

/**
 * Router names are global on a worker; application names are not.
 *
 * `/applications/new` and the Kubernetes API both enforce uniqueness per team,
 * and the edit form enforces none at all — so two teams each running a `web`
 * on one worker is ordinary, not contrived. Without the application id in the
 * identifier, `routeGroupsForWorker` merged them into a single router and
 * appended one team's container to the other team's load balancer.
 */
describe('createRouteAssigner — router identifiers', () => {
  const OTHER = '99999999-2222-3333-4444-555555555555';

  test('two applications with the same name get different routers', () => {
    const mine = createRouteAssigner(ctxFor())('web', 31000);
    const theirs = createRouteAssigner(ctxFor({ appId: OTHER }))('web', 31001);

    expect(mine.routerName).not.toBe(theirs.routerName);
    expect(mine.routerName).toBe('shop-11111111');
    expect(theirs.routerName).toBe('shop-99999999');
  });

  test('a secondary service carries it too', () => {
    const assign = createRouteAssigner(ctxFor());
    assign('web', 31000);
    expect(assign('api', 31001).routerName).toBe('shop-api-11111111');
  });

  test('replicas of one application share a router, so Traefik balances them', () => {
    // Same application, same name: the grouping in `routeGroupsForWorker` is
    // what turns several containers into one service with several servers.
    const ctx = ctxFor();
    expect(createRouteAssigner(ctx)('web', 31000).routerName).toBe(
      createRouteAssigner(ctx)('web', 31001).routerName,
    );
  });

  test('the hostname is untouched — only the identifier carries the id', () => {
    const route = createRouteAssigner(ctxFor())('web', 31000);
    expect(route.domain).toBe('shop.apps.example.com');
  });
});

describe('createRouteAssigner — rejects a hostname that is not one', () => {
  /** The injection this guards: a backtick closes the matcher Traefik is parsing. */
  const INJECTED = 'shop.example.com`) || Host(`victim.example.com';

  test('refuses to route a stored domain carrying rule syntax', () => {
    // Reached through a row written before the domain was validated at the write
    // sites. Validating only on write cannot clean up what is already stored,
    // and this is the last place the value can still be stopped.
    const assign = createRouteAssigner(ctxFor({ appDomain: INJECTED }));
    expect(() => assign('web', 31000)).toThrow(ManifestError);
  });

  test('the message names the application and the reason', () => {
    const assign = createRouteAssigner(ctxFor({ appDomain: INJECTED }));
    expect(() => assign('web', 31000)).toThrow(/shop.*illegal character/s);
  });

  test('throws before returning a route, so nothing is created from it', () => {
    // ManifestError is the pre-flight failure: the plan is built before any
    // container exists, so a deploy that trips this changes nothing on the
    // worker.
    const assign = createRouteAssigner(ctxFor({ appDomain: INJECTED }));
    let route;
    try {
      route = assign('web', 31000);
    } catch {
      /* expected */
    }
    expect(route).toBeUndefined();
  });

  test('rejects the other shapes a stored domain can take', () => {
    for (const appDomain of [
      'a.example.com && PathPrefix(`/x`)',
      'a.example.com) || Host(b.example.com',
      'a b.example.com',
      'a..example.com',
      '-bad.example.com',
    ]) {
      const assign = createRouteAssigner(ctxFor({ appDomain }));
      expect(() => assign('web', 31000), appDomain).toThrow(ManifestError);
    }
  });

  test('an empty stored domain falls through to the generated one', () => {
    // Empty means "no explicit hostname", not "an invalid one" — the column is
    // nullable and most applications leave it unset.
    for (const appDomain of [null, undefined, '']) {
      const assign = createRouteAssigner(ctxFor({ appDomain }));
      expect(assign('web', 31000).domain).toBe('shop.apps.example.com');
    }
  });
});
