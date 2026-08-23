import { describe, expect, test } from 'bun:test';
import {
  configForRouteGroups,
  labelsToDynamicConfig,
  buildMiddlewareOpts,
  pruneEmptySections,
  assembleWorkerConfig,
  tokenForwardingApps,
} from './traefik-config';
import { generateTraefikLabelsForApp } from './provisioning';
import { encryptField } from './encryption';

/**
 * The migration from container labels to control-plane-served configuration is
 * only safe if both describe the same routing. These tests are that argument:
 * they run the label generator the deploy path uses, convert its output, and
 * assert the resulting document.
 */

const OIDC = {
  providerURL: 'https://idp.example.com',
  clientID: 'shop',
  clientSecret: 'sh',
  sessionEncryptionKey: 'a'.repeat(32),
};

function convert(labels: Record<string, string>) {
  return labelsToDynamicConfig(labels);
}

describe('labelsToDynamicConfig — routers', () => {
  const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000);
  const doc = convert(labels);

  test('drops the docker-provider-only enable flag', () => {
    expect(JSON.stringify(doc)).not.toContain('traefik.enable');
  });

  test('carries the Host rule verbatim', () => {
    expect(doc.http.routers['shop-secure'].rule).toBe('Host(`shop.example.com`)');
  });

  test('turns the comma-joined entrypoints into a list', () => {
    expect(doc.http.routers['shop-secure'].entryPoints).toEqual(['websecure']);
  });

  test('turns `tls: "true"` into the object the file provider expects', () => {
    expect(doc.http.routers['shop-secure'].tls).toEqual({ certResolver: 'letsencrypt' });
  });

  test('keeps the middleware chain and its order', () => {
    expect(doc.http.routers['shop-secure'].middlewares).toEqual([
      'crowdsec@file',
      'security-headers@file',
    ]);
  });

  test('points the router at its service', () => {
    expect(doc.http.routers['shop-secure'].service).toBe('shop');
  });

  test('keeps the WebSocket router', () => {
    expect(doc.http.routers['shop-secure-ws'].rule).toContain('Header(`Upgrade`');
  });
});

describe('labelsToDynamicConfig — services', () => {
  test('expands server.url into a servers list', () => {
    const doc = convert(generateTraefikLabelsForApp('shop', 'shop.example.com', 31000));
    expect(doc.http.services.shop.loadBalancer.servers).toEqual([
      { url: 'http://127.0.0.1:31000' },
    ]);
  });

  test('camel-cases the health check block', () => {
    const doc = convert(
      generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
        healthCheckPath: '/healthz',
      }),
    );
    expect(doc.http.services.shop.loadBalancer.healthCheck).toEqual({
      path: '/healthz',
      interval: '10s',
      timeout: '5s',
    });
  });
});

describe('labelsToDynamicConfig — middlewares', () => {
  test('rate limit numbers deserialise as numbers, not strings', () => {
    const doc = convert(
      generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
        rateLimitAvg: 100,
        rateLimitBurst: 250,
      }),
    );
    const rl = doc.http.middlewares['shop-ratelimit'].rateLimit;
    expect(rl.average).toBe(100);
    expect(rl.burst).toBe(250);
    expect(typeof rl.average).toBe('number');
    // A duration stays a string — Traefik parses it itself.
    expect(rl.period).toBe('1s');
  });

  test('rewrites @docker references to @file', () => {
    // In labels mode the per-app middleware is defined by the docker provider.
    // Here the same file defines and references it, so a stale @docker suffix
    // would leave the router pointing at a middleware that does not exist —
    // and Traefik drops routers with unresolvable middlewares.
    const doc = convert(
      generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
        rateLimitAvg: 100,
      }),
    );
    expect(doc.http.routers['shop-secure'].middlewares).toContain('shop-ratelimit@file');
    expect(JSON.stringify(doc)).not.toContain('@docker');
  });

  test('per-app OIDC keeps the plugin schema exactly as the plugin expects', () => {
    const doc = convert(
      generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
        authType: 'oidc',
        authConfig: { ...OIDC, allowedUsers: ['a@example.com', 'b@example.com'] },
      }),
    );
    const plugin = doc.http.middlewares['shop-oidc'].plugin['traefik-oidc-auth'];
    expect(plugin.Provider.Url).toBe('https://idp.example.com');
    expect(plugin.Provider.UsePkce).toBe(true);
    expect(plugin.Secret).toHaveLength(32);
    expect(plugin.CallbackUri).toBe('/oidc/callback');
    expect(plugin.Authorization.CheckOnEveryRequest).toBe(true);
  });

  test('indexed label keys become arrays', () => {
    const doc = convert(
      generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
        authType: 'oidc',
        authConfig: { ...OIDC, allowedUsers: ['a@example.com', 'b@example.com'] },
      }),
    );
    const plugin = doc.http.middlewares['shop-oidc'].plugin['traefik-oidc-auth'];
    expect(plugin.Scopes).toEqual(['openid', 'profile', 'email']);
    expect(plugin.Authorization.AssertClaims[0].Name).toBe('email');
    expect(plugin.Authorization.AssertClaims[0].AnyOf).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  test('global OIDC is referenced but not redefined', () => {
    const doc = convert(generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, undefined, true));
    expect(doc.http.routers['shop-secure'].middlewares).toContain('global-oidc@file');
    // The middleware itself comes from the worker's OIDC settings, merged in by
    // buildWorkerDynamicConfig — not from the label conversion.
    expect(doc.http.middlewares['global-oidc']).toBeUndefined();
  });
});

describe('equivalence with the label output', () => {
  /** Every routing fact a label expresses must survive the conversion. */
  const cases: Array<[string, Parameters<typeof generateTraefikLabelsForApp>]> = [
    ['plain app', ['shop', 'shop.example.com', 31000]],
    ['rate limited', ['shop', 'shop.example.com', 31000, true, { rateLimitAvg: 50 }]],
    ['health checked', ['shop', 'shop.example.com', 31000, true, { healthCheckPath: '/up' }]],
    ['global oidc', ['shop', 'shop.example.com', 31000, true, undefined, true]],
    ['public app', ['shop', 'shop.example.com', 31000, true, { authType: 'none' }, true]],
    ['per-app oidc', ['shop', 'shop.example.com', 31000, true, { authType: 'oidc', authConfig: OIDC }]],
    ['no websocket', ['shop', 'shop.example.com', 31000, false]],
  ];

  for (const [name, args] of cases) {
    test(`${name}: every router, service and middleware is carried over`, () => {
      const labels = generateTraefikLabelsForApp(...args);
      const doc = convert(labels);

      const namesIn = (kind: string) =>
        new Set(
          Object.keys(labels)
            .filter((k) => k.startsWith(`traefik.http.${kind}.`))
            .map((k) => k.split('.')[3]),
        );

      expect(new Set(Object.keys(doc.http.routers))).toEqual(namesIn('routers'));
      expect(new Set(Object.keys(doc.http.services))).toEqual(namesIn('services'));
      expect(new Set(Object.keys(doc.http.middlewares))).toEqual(namesIn('middlewares'));

      // The middleware chain is the part most likely to silently lose an entry.
      const chain = labels['traefik.http.routers.shop-secure.middlewares'].split(',');
      expect(doc.http.routers['shop-secure'].middlewares).toHaveLength(chain.length);
    });
  }

  test('no label value is left behind as an unconverted dotted key', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      rateLimitAvg: 10,
      authType: 'oidc',
      authConfig: { ...OIDC, excludedURLs: ['/health', '/metrics'] },
    });
    const flat = JSON.stringify(convert(labels));
    expect(flat).not.toContain('traefik.http.');
    expect(flat).not.toContain('loadbalancer');
    expect(flat).not.toContain('certresolver');
  });
});

describe('configForRouteGroups', () => {
  test('replicas collapse into one service with one server each', () => {
    const doc = configForRouteGroups(
      [{ routerBase: 'shop', domain: 'shop.example.com', ports: [31000, 31001, 31002] }],
      false,
    );
    expect(doc.http.services.shop.loadBalancer.servers).toEqual([
      { url: 'http://127.0.0.1:31000' },
      { url: 'http://127.0.0.1:31001' },
      { url: 'http://127.0.0.1:31002' },
    ]);
    expect(Object.keys(doc.http.routers)).toEqual(['shop-secure', 'shop-secure-ws']);
  });

  test('several applications merge without colliding', () => {
    const doc = configForRouteGroups(
      [
        { routerBase: 'shop', domain: 'shop.example.com', ports: [31000] },
        { routerBase: 'shop-api', domain: 'shop-api.example.com', ports: [31001] },
      ],
      false,
    );
    expect(Object.keys(doc.http.routers).sort()).toEqual([
      'shop-api-secure',
      'shop-api-secure-ws',
      'shop-secure',
      'shop-secure-ws',
    ]);
    expect(doc.http.services.shop.loadBalancer.servers[0].url).toBe('http://127.0.0.1:31000');
    expect(doc.http.services['shop-api'].loadBalancer.servers[0].url).toBe('http://127.0.0.1:31001');
  });

  test('a group with no running container is skipped, not emitted empty', () => {
    const doc = configForRouteGroups(
      [{ routerBase: 'shop', domain: 'shop.example.com', ports: [] }],
      false,
    );
    expect(doc.http.routers).toEqual({});
    expect(doc.http.services).toEqual({});
  });

  test('a group whose domain is not a hostname is skipped, not serialised', () => {
    // This path reads `applications.domain` straight from the database, so it
    // reaches rows written before the domain was validated on the way in. The
    // value becomes the interior of a ``Host(`…`)`` rule, which Traefik parses
    // as an expression: a backtick closes the matcher and what follows is rule
    // logic — here a second, longer router for a host this application does not
    // own, which Traefik would prefer over the real one.
    const doc = configForRouteGroups(
      [
        {
          routerBase: 'evil',
          domain: 'evil.example.com`) || Host(`victim.example.com',
          ports: [31000],
        },
      ],
      false,
    );
    expect(doc.http.routers).toEqual({});
    expect(doc.http.services).toEqual({});
    expect(JSON.stringify(doc)).not.toContain('victim');
  });

  test('one bad domain does not cost the other applications their routes', () => {
    // Skipping the group rather than throwing is the point: a single malformed
    // row must not fail whole-worker config generation and take every other
    // application offline with it.
    const doc = configForRouteGroups(
      [
        { routerBase: 'evil', domain: 'a`) || Host(`b', ports: [31000] },
        { routerBase: 'shop', domain: 'shop.example.com', ports: [31001] },
      ],
      false,
    );
    expect(Object.keys(doc.http.routers).sort()).toEqual(['shop-secure', 'shop-secure-ws']);
    expect(doc.http.services.shop.loadBalancer.servers[0].url).toBe('http://127.0.0.1:31001');
  });

  test('authType none suppresses OIDC even when the worker has it', () => {
    const doc = configForRouteGroups(
      [
        {
          routerBase: 'shop',
          domain: 'shop.example.com',
          ports: [31000],
          middlewareOpts: { authType: 'none' },
        },
      ],
      true,
    );
    expect(doc.http.routers['shop-secure'].middlewares).not.toContain('global-oidc@file');
  });
});

describe('pruneEmptySections', () => {
  // Traefik 3.7.10 rejects a document containing an empty section with
  // "middlewares cannot be a standalone element", and rejects the *whole file*
  // — so one empty map takes every router on the worker down. An application
  // with no rate limit and no per-app OIDC produces exactly that document.
  // Confirmed on a live worker: identical document minus the empty key loads.
  test('drops a section with nothing in it', () => {
    const served = pruneEmptySections(
      configForRouteGroups([{ routerBase: 'shop', domain: 'shop.example.com', ports: [31000] }], false),
    );
    expect(served.http.routers).toBeDefined();
    expect(served.http.services).toBeDefined();
    expect('middlewares' in served.http).toBe(false);
  });

  test('keeps a section that has content', () => {
    const served = pruneEmptySections(
      configForRouteGroups(
        [
          {
            routerBase: 'shop',
            domain: 'shop.example.com',
            ports: [31000],
            middlewareOpts: { rateLimitAvg: 10 },
          },
        ],
        false,
      ),
    );
    expect(Object.keys(served.http.middlewares!)).toEqual(['shop-ratelimit']);
  });

  test('a worker with no applications yields no sections at all', () => {
    const served = pruneEmptySections(configForRouteGroups([], false));
    expect(served).toEqual({ http: {} });
  });
});

describe('assembleWorkerConfig', () => {
  const GROUPS = [{ routerBase: 'shop', domain: 'shop.example.com', ports: [31000] }];

  test('never serves an empty section', () => {
    // The pruning has to happen on the path that actually reaches the worker,
    // not merely be available. Traefik discards the entire file over one empty
    // map, so this is the difference between routing and a fleet of 404s.
    const served = assembleWorkerConfig(GROUPS, false);
    for (const [name, section] of Object.entries(served.http)) {
      expect(Object.keys(section as object).length, `${name} is empty`).toBeGreaterThan(0);
    }
    expect('middlewares' in served.http).toBe(false);
  });

  test('merges the worker OIDC middleware in alongside the routes', () => {
    const oidc = {
      http: {
        routers: { 'global-oidc-callback': { rule: 'Host(`auth.example.com`)' } },
        services: {},
        middlewares: { 'global-oidc': { plugin: { 'traefik-oidc-auth': { Secret: 'x' } } } },
      },
    };
    const served = assembleWorkerConfig(GROUPS, true, oidc);
    expect(served.http.middlewares!['global-oidc']).toBeDefined();
    expect(served.http.routers!['global-oidc-callback']).toBeDefined();
    // The app router references it, and now the definition ships with it —
    // that is what removes the manual "Apply to Traefik" step.
    expect(served.http.routers!['shop-secure'].middlewares).toContain('global-oidc@file');
  });

  test('a worker with nothing deployed serves an empty document', () => {
    expect(assembleWorkerConfig([], false)).toEqual({ http: {} });
  });
});

describe('buildMiddlewareOpts', () => {
  test('reports nothing for an application with no routing settings', () => {
    expect(buildMiddlewareOpts({ authType: 'global' })).toBeUndefined();
  });

  test('derives the burst from the average when unset', () => {
    expect(buildMiddlewareOpts({ rateLimitAvg: 40 })).toMatchObject({
      rateLimitAvg: 40,
      rateLimitBurst: 80,
    });
  });

  test('extracts the health check path from a curl healthcheck', () => {
    const opts = buildMiddlewareOpts({
      healthcheck: JSON.stringify({ test: 'curl -f http://localhost:80/healthz' }),
    });
    expect(opts?.healthCheckPath).toBe('/healthz');
  });

  test('malformed auth config does not become an unauthenticated app by accident', () => {
    // authType stays 'oidc' with no config, so generateTraefikLabelsForApp
    // emits no OIDC middleware — the deploy path rejects this separately.
    const opts = buildMiddlewareOpts({ authType: 'oidc', authConfig: '{not json' });
    expect(opts).toBeUndefined();
  });

  // ── auth_config is encrypted at rest ───────────────────────────────────────
  //
  // The column carries the per-app OIDC client secret and the plugin's AES key.
  // It was stored in plain text while every other credential went through
  // `encryptField`; both shapes have to keep working, because rows written
  // before the change are still in deployed databases.

  test('reads an encrypted auth config', () => {
    const cfg = {
      providerURL: 'https://idp.example.com',
      clientID: 'shop',
      clientSecret: 'super-secret',
      sessionEncryptionKey: 'a'.repeat(32),
    };
    const opts = buildMiddlewareOpts({
      authType: 'oidc',
      authConfig: encryptField(JSON.stringify(cfg)),
    });
    expect(opts?.authConfig).toEqual(cfg);
  });

  test('still reads a legacy plaintext auth config', () => {
    const cfg = {
      providerURL: 'https://idp.example.com',
      clientID: 'shop',
      clientSecret: 'super-secret',
      sessionEncryptionKey: 'a'.repeat(32),
    };
    const opts = buildMiddlewareOpts({ authType: 'oidc', authConfig: JSON.stringify(cfg) });
    expect(opts?.authConfig).toEqual(cfg);
  });

  test('encryptField does not double-encrypt on re-save', () => {
    const once = encryptField('{"clientSecret":"s"}')!;
    expect(encryptField(once)).toBe(once);
  });

  test('the stored form does not contain the secret in the clear', () => {
    const stored = encryptField(JSON.stringify({ clientSecret: 'super-secret' }))!;
    expect(stored).not.toContain('super-secret');
    expect(stored).not.toContain('clientSecret');
  });

  test('carries the token header names an application saved', () => {
    expect(
      buildMiddlewareOpts({ oidcIdTokenHeader: 'X-Id', oidcAccessTokenHeader: '  ' })?.tokenHeaders,
    ).toEqual({ idTokenHeader: 'X-Id', accessTokenHeader: null });
  });

  test('an application that named no header is still an application with no settings', () => {
    expect(buildMiddlewareOpts({ oidcIdTokenHeader: null, oidcAccessTokenHeader: '' })).toBeUndefined();
  });
});

describe('tokenForwardingApps', () => {
  const group = (routerBase: string, middlewareOpts: any) => ({
    routerBase,
    domain: `${routerBase}.example.com`,
    ports: [3000],
    middlewareOpts,
  });

  test('names the applications whose routers reference a copy of the middleware', () => {
    const groups = [
      group('shop', { tokenHeaders: { idTokenHeader: 'X-Id' } }),
      group('blog', undefined),
    ];
    expect(tokenForwardingApps(groups, true)).toEqual([
      { routerBase: 'shop', idTokenHeader: 'X-Id', accessTokenHeader: null },
    ]);
  });

  test('nothing at all when the worker has no global OIDC', () => {
    const groups = [group('shop', { tokenHeaders: { idTokenHeader: 'X-Id' } })];
    expect(tokenForwardingApps(groups, false)).toEqual([]);
  });

  test('skips an application that is not routed through the worker middleware', () => {
    // Defining a middleware nothing references is only clutter, but the two
    // decisions have to be made by the same function — the dangerous direction
    // is a router naming a middleware that was never defined.
    const groups = [
      group('public', { authType: 'none', tokenHeaders: { idTokenHeader: 'X-Id' } }),
      group('own-idp', {
        authType: 'oidc',
        authConfig: OIDC,
        tokenHeaders: { idTokenHeader: 'X-Id' },
      }),
      group('opted-out', { useGlobalAuth: false, tokenHeaders: { idTokenHeader: 'X-Id' } }),
    ];
    expect(tokenForwardingApps(groups, true)).toEqual([]);
  });

  test('every middleware a generated router names is one the renderer defines', () => {
    // The invariant the whole design rests on: Traefik drops a router whose
    // middleware is missing, so the application would 404 rather than 401.
    const groups = [
      group('shop', { tokenHeaders: { idTokenHeader: 'X-Id' } }),
      group('blog', { tokenHeaders: { accessTokenHeader: 'X-Access' } }),
      group('plain', undefined),
    ];
    const config = configForRouteGroups(groups, true);
    const referenced = Object.values(config.http.routers)
      .flatMap((r: any) => r.middlewares ?? [])
      .filter((m: string) => m.endsWith('-oidc-tokens@file'));
    const defined = tokenForwardingApps(groups, true).map((a) => `${a.routerBase}-oidc-tokens@file`);

    expect(referenced.length).toBeGreaterThan(0);
    expect([...new Set(referenced)].sort()).toEqual(defined.sort());
  });
});
