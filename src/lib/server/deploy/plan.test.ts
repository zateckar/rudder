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
import {
  ENTRYPOINT_PORTS,
  MAX_ROUTES_PER_CONTAINER,
  ManifestError,
  ROUTE_ENTRYPOINTS,
  createRouteAssigner,
  parseExposedPorts,
  parsePortList,
  routeSelectionNotes,
  selectRouteBindings,
  serializeExposedPorts,
  type PlanContext,
} from './plan';

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

/**
 * One container port on one host port — the shape almost every application has.
 *
 * The assigner takes a list because a container may publish several, but the
 * hostname and router-identifier rules it enforces are per container, not per
 * port, and reading those tests is easier without the list noise.
 */
function one(
  assign: ReturnType<typeof createRouteAssigner>,
  key: string,
  hostPort: number,
  containerPort = 80,
) {
  return assign(key, [{ containerPort, hostPort }])[0];
}

/** Podman-style bindings from `[containerPort, hostPort]` pairs. */
function bindings(...pairs: Array<[number, number, string?]>) {
  return Object.fromEntries(
    pairs.map(([containerPort, hostPort, proto]) => [
      `${containerPort}/${proto ?? 'tcp'}`,
      [{ hostPort: String(hostPort) }],
    ]),
  );
}

describe('createRouteAssigner — hostnames', () => {
  test('the first port owns the application hostname', () => {
    const assign = createRouteAssigner(ctxFor());
    expect(one(assign, 'web', 31000).domain).toBe('shop.apps.example.com');
  });

  test('later services are disambiguated inside the same label', () => {
    const assign = createRouteAssigner(ctxFor());
    one(assign, 'web', 31000);
    expect(one(assign, 'api', 31001).domain).toBe('shop-api.apps.example.com');
  });

  test('an explicit domain wins over the generated one', () => {
    const assign = createRouteAssigner(ctxFor({ appDomain: 'shop.example.net' }));
    expect(one(assign, 'web', 31000).domain).toBe('shop.example.net');
  });

  test('normalises the fallback when there is no base domain', () => {
    // The fallback used to be the raw application name, which is not a hostname:
    // "My Shop" would have been interpolated into a Host() rule with a space in
    // it. It goes through toDnsLabel now, like routerName already did.
    const assign = createRouteAssigner(ctxFor({ appName: 'My Shop', baseDomain: null }));
    const route = one(assign, 'web', 31000);
    expect(route.domain).toBe('my-shop');
    expect(route.routerName).toBe('my-shop-11111111');
  });

  test('normalises the secondary fallback too', () => {
    const assign = createRouteAssigner(ctxFor({ appName: 'My Shop', baseDomain: null }));
    one(assign, 'web', 31000);
    expect(one(assign, 'API v2', 31001).domain).toBe('my-shop-api-v2');
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
    const mine = one(createRouteAssigner(ctxFor()), 'web', 31000);
    const theirs = one(createRouteAssigner(ctxFor({ appId: OTHER })), 'web', 31001);

    expect(mine.routerName).not.toBe(theirs.routerName);
    expect(mine.routerName).toBe('shop-11111111');
    expect(theirs.routerName).toBe('shop-99999999');
  });

  test('a secondary service carries it too', () => {
    const assign = createRouteAssigner(ctxFor());
    one(assign, 'web', 31000);
    expect(one(assign, 'api', 31001).routerName).toBe('shop-api-11111111');
  });

  test('replicas of one application share a router, so Traefik balances them', () => {
    // Same application, same name: the grouping in `routeGroupsForWorker` is
    // what turns several containers into one service with several servers.
    const ctx = ctxFor();
    expect(one(createRouteAssigner(ctx), 'web', 31000).routerName).toBe(
      one(createRouteAssigner(ctx), 'web', 31001).routerName,
    );
  });

  test('the hostname is untouched — only the identifier carries the id', () => {
    const route = one(createRouteAssigner(ctxFor()), 'web', 31000);
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
    expect(() => one(assign, 'web', 31000)).toThrow(ManifestError);
  });

  test('the message names the application and the reason', () => {
    const assign = createRouteAssigner(ctxFor({ appDomain: INJECTED }));
    expect(() => one(assign, 'web', 31000)).toThrow(/shop.*illegal character/s);
  });

  test('throws before returning a route, so nothing is created from it', () => {
    // ManifestError is the pre-flight failure: the plan is built before any
    // container exists, so a deploy that trips this changes nothing on the
    // worker.
    const assign = createRouteAssigner(ctxFor({ appDomain: INJECTED }));
    let route;
    try {
      route = one(assign, 'web', 31000);
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
      expect(() => one(assign, 'web', 31000), appDomain).toThrow(ManifestError);
    }
  });

  test('an empty stored domain falls through to the generated one', () => {
    // Empty means "no explicit hostname", not "an invalid one" — the column is
    // nullable and most applications leave it unset.
    for (const appDomain of [null, undefined, '']) {
      const assign = createRouteAssigner(ctxFor({ appDomain }));
      expect(one(assign, 'web', 31000).domain).toBe('shop.apps.example.com');
    }
  });
});

describe('selectRouteBindings — which ports are public', () => {
  const PORTS = bindings([7070, 31000], [7071, 31001], [8080, 31002]);

  test('undeclared routes the first published port and nothing else', () => {
    // The case almost every deployed application is in. If this changes, every
    // application on every worker changes with it.
    for (const declared of [null, undefined]) {
      const selection = selectRouteBindings(declared, PORTS);
      expect(selection.bindings).toEqual([{ containerPort: 7070, hostPort: 31000 }]);
      expect(routeSelectionNotes('web', selection)).toEqual([]);
    }
  });

  test('the declaration is the mapping, in the order it was written', () => {
    const selection = selectRouteBindings([8080, 7070], PORTS);
    expect(selection.bindings).toEqual([
      { containerPort: 8080, hostPort: 31002 },
      { containerPort: 7070, hostPort: 31000 },
    ]);
  });

  test('an empty declaration routes nothing, and is not the same as undeclared', () => {
    expect(selectRouteBindings([], PORTS).bindings).toEqual([]);
    expect(selectRouteBindings(null, PORTS).bindings).toHaveLength(1);
  });

  test('a declared port nothing publishes is reported, not silently dropped', () => {
    // Otherwise the symptom is an application unreachable on a port its owner
    // believes they configured, with a deploy that reported success.
    const selection = selectRouteBindings([7070, 9999], PORTS);
    expect(selection.bindings).toHaveLength(1);
    expect(selection.unpublished).toEqual([9999]);
    expect(routeSelectionNotes('web', selection).join('\n')).toContain('9999');
  });

  test('a UDP-only port is reported rather than given a router that cannot work', () => {
    const selection = selectRouteBindings([53], bindings([53, 31005, 'udp']));
    expect(selection.bindings).toEqual([]);
    expect(selection.notTcp).toEqual([53]);
    expect(routeSelectionNotes('dns', selection).join('\n')).toContain('UDP');
  });

  test('prefers the TCP binding when a port is published on both protocols', () => {
    const selection = selectRouteBindings([80], bindings([80, 31009, 'udp'], [80, 31010, 'tcp']));
    expect(selection.bindings).toEqual([{ containerPort: 80, hostPort: 31010 }]);
  });

  test('stops at the entryPoint ceiling and names what it dropped', () => {
    const many = bindings(
      [1, 31001], [2, 31002], [3, 31003], [4, 31004], [5, 31005], [6, 31006],
    );
    const selection = selectRouteBindings([1, 2, 3, 4, 5, 6], many);
    expect(selection.bindings).toHaveLength(MAX_ROUTES_PER_CONTAINER);
    expect(selection.overflow).toEqual([6]);
    expect(routeSelectionNotes('web', selection).join('\n')).toContain('6');
  });
});

describe('createRouteAssigner — entryPoints', () => {
  test('the first route is always 443, whatever the container port', () => {
    // ACME's TLS-ALPN-01 challenge is served on 443 alone, so a hostname with no
    // router there never obtains the certificate the others would serve.
    const assign = createRouteAssigner(ctxFor());
    const routes = assign('web', [
      { containerPort: 8080, hostPort: 31002 },
      { containerPort: 7070, hostPort: 31000 },
    ]);
    expect(routes.map((r) => r.entryPoint)).toEqual(['websecure', 'websecure-1']);
    expect(ENTRYPOINT_PORTS[routes[0].entryPoint]).toBe(443);
    expect(ENTRYPOINT_PORTS[routes[1].entryPoint]).toBe(1443);
  });

  test('every route of a container shares one hostname', () => {
    // This is what makes a second published port free of new DNS and a new
    // certificate. If it ever stops being true, both become required.
    const routes = createRouteAssigner(ctxFor())('web', [
      { containerPort: 7070, hostPort: 31000 },
      { containerPort: 8080, hostPort: 31002 },
    ]);
    expect(new Set(routes.map((r) => r.domain)).size).toBe(1);
  });

  test('the 443 router keeps the name it has always had', () => {
    // No deployed application may see its router renamed by this feature: a
    // labels-mode worker's configuration has to stay byte-identical until
    // someone declares a second port.
    const routes = createRouteAssigner(ctxFor())('web', [
      { containerPort: 7070, hostPort: 31000 },
      { containerPort: 8080, hostPort: 31002 },
    ]);
    expect(routes[0].routerName).toBe('shop-11111111');
    expect(routes[1].routerName).toBe('shop-11111111-p1');
  });

  test('router names are distinct across ports and across services', () => {
    // Router names are global on a worker, so a collision routes one
    // application's traffic to another's container.
    const assign = createRouteAssigner(ctxFor());
    const web = assign('web', [
      { containerPort: 7070, hostPort: 31000 },
      { containerPort: 8080, hostPort: 31002 },
    ]);
    const api = assign('api', [
      { containerPort: 7070, hostPort: 31010 },
      { containerPort: 8080, hostPort: 31012 },
    ]);
    const names = [...web, ...api].map((r) => r.routerName);
    expect(new Set(names).size).toBe(names.length);
  });

  test('never hands out more routes than there are entryPoints', () => {
    const assign = createRouteAssigner(ctxFor());
    const routes = assign(
      'web',
      Array.from({ length: 9 }, (_, i) => ({ containerPort: 1000 + i, hostPort: 31000 + i })),
    );
    expect(routes).toHaveLength(MAX_ROUTES_PER_CONTAINER);
    expect(routes.map((r) => r.entryPoint)).toEqual([...ROUTE_ENTRYPOINTS]);
  });

  test('no bindings, no routes — and no hostname is claimed', () => {
    // The assigner marks the application hostname as taken on its first call.
    // A container that publishes nothing must not consume it, or the next
    // container gets `shop-api.` while `shop.` routes nowhere.
    const assign = createRouteAssigner(ctxFor());
    expect(assign('worker', [])).toEqual([]);
    expect(one(assign, 'web', 31000).domain).toBe('shop.apps.example.com');
  });
});

describe('the declaration survives storage and transport', () => {
  test('a comma-separated list round-trips through the column', () => {
    const parsed = parsePortList('7070, 8080');
    expect(parsed).toEqual([7070, 8080]);
    expect(parseExposedPorts(serializeExposedPorts(parsed))).toEqual([7070, 8080]);
  });

  test('order is preserved, because order is the mapping', () => {
    expect(parseExposedPorts(serializeExposedPorts(parsePortList('8080,7070')))).toEqual([
      8080, 7070,
    ]);
  });

  test('undeclared stays undeclared, and empty stays empty', () => {
    expect(serializeExposedPorts(null)).toBeNull();
    expect(parseExposedPorts(null)).toBeNull();
    expect(parseExposedPorts('')).toBeNull();
    expect(parseExposedPorts(serializeExposedPorts([]))).toEqual([]);
  });

  test('a value that is not a port list is refused, not guessed at', () => {
    // Reading a typo as "route nothing" would take an application off the air
    // over a stray character.
    for (const bad of ['7070;8080', 'http', '0', '70000', '80,,81', '-1']) {
      expect(parsePortList(bad), bad).toBeNull();
    }
  });

  test('a column holding something unexpected degrades to undeclared', () => {
    // This value reaches the routing generator. Throwing would cost the
    // application its routing entirely; falling back to one route does not.
    for (const bad of ['{}', 'not json', '[null]', '"7070"']) {
      expect(parseExposedPorts(bad), bad).not.toBeUndefined();
    }
    expect(parseExposedPorts('not json')).toBeNull();
    expect(parseExposedPorts('[70000, 80]')).toEqual([80]);
  });
});
