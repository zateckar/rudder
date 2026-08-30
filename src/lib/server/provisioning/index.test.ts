import { describe, expect, test } from 'bun:test';
import {
  PLATFORM_IMAGES,
  generateProvisioningScript,
  generateTraefikLabelsForApp,
  isPlainPathPrefix,
  renderGlobalOidcConfig,
  type AppMiddlewareOptions,
  type AppTokenForwarding,
} from './index';

const OIDC_CONFIG: NonNullable<AppMiddlewareOptions['authConfig']> = {
  providerURL: 'https://idp.example.com',
  clientID: 'shop-client',
  clientSecret: 'shop-secret',
  sessionEncryptionKey: 'a'.repeat(32),
};

/** Middleware chain the router ends up with, in order. */
function chain(labels: Record<string, string>, router = 'shop-secure'): string[] {
  const value = labels[`traefik.http.routers.${router}.middlewares`];
  return value ? value.split(',') : [];
}

describe('generateTraefikLabelsForApp — routing', () => {
  test('emits an HTTPS router, service and websocket router', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000);

    expect(labels['traefik.enable']).toBe('true');
    expect(labels['traefik.http.routers.shop-secure.rule']).toBe('Host(`shop.example.com`)');
    expect(labels['traefik.http.routers.shop-secure.entrypoints']).toBe('websecure');
    expect(labels['traefik.http.routers.shop-secure.tls.certresolver']).toBe('letsencrypt');
    expect(labels['traefik.http.services.shop.loadbalancer.server.url']).toBe('http://127.0.0.1:31000');
    expect(labels['traefik.http.routers.shop-secure-ws.rule']).toContain('Upgrade');
  });

  test('router names derive from the app name the same way hostnames do', () => {
    const labels = generateTraefikLabelsForApp('My Shop', 'my-shop.example.com', 31000);
    expect(labels['traefik.http.routers.my-shop-secure.rule']).toBe('Host(`my-shop.example.com`)');
  });

  test('omits the websocket router when disabled', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, false);
    expect(labels['traefik.http.routers.shop-secure-ws.rule']).toBeUndefined();
  });

  test('adds health check settings only when a path is given', () => {
    const without = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000);
    expect(without['traefik.http.services.shop.loadbalancer.healthcheck.path']).toBeUndefined();

    const withPath = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      healthCheckPath: '/health',
    });
    expect(withPath['traefik.http.services.shop.loadbalancer.healthcheck.path']).toBe('/health');
  });
});

describe('generateTraefikLabelsForApp — several published ports', () => {
  /** versitygw's shape: a web UI on 443, the S3 API on 1443. */
  const ROUTES = [
    { key: '', entryPoint: 'websecure', hostPort: 31000 },
    { key: 'p1', entryPoint: 'websecure-1', hostPort: 31001 },
  ];

  test('a bare port is still the 443 route and nothing else', () => {
    // Every caller used this shape before extra entryPoints existed. A
    // single-route application's labels have to stay byte-identical or every
    // deployed application's routing changes underneath it.
    const bare = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      rateLimitAvg: 10,
    });
    const explicit = generateTraefikLabelsForApp(
      'shop',
      'shop.example.com',
      [{ key: '', entryPoint: 'websecure', hostPort: 31000 }],
      true,
      { rateLimitAvg: 10 },
    );
    expect(bare).toEqual(explicit);
  });

  test('emits a router and a service per route, on its own entryPoint', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', ROUTES);

    expect(labels['traefik.http.routers.shop-secure.entrypoints']).toBe('websecure');
    expect(labels['traefik.http.routers.shop-p1-secure.entrypoints']).toBe('websecure-1');
    // Same hostname: one DNS record, one certificate.
    expect(labels['traefik.http.routers.shop-p1-secure.rule']).toBe('Host(`shop.example.com`)');
    expect(labels['traefik.http.routers.shop-p1-secure.tls.certresolver']).toBe('letsencrypt');
    // Each points at its own backend.
    expect(labels['traefik.http.services.shop.loadbalancer.server.url']).toBe('http://127.0.0.1:31000');
    expect(labels['traefik.http.services.shop-p1.loadbalancer.server.url']).toBe('http://127.0.0.1:31001');
    expect(labels['traefik.http.routers.shop-p1-secure.service']).toBe('shop-p1');
  });

  test('the WAF, the headers and the rate limit are on every route', () => {
    // The claim that the extra ports are not a way around Traefik. If this
    // breaks, opening 1443-4443 becomes exactly the hole the firewall exists to
    // prevent.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', ROUTES, true, {
      rateLimitAvg: 10,
    });
    for (const router of ['shop-secure', 'shop-p1-secure']) {
      expect(chain(labels, router)).toContain('crowdsec@file');
      expect(chain(labels, router)).toContain('security-headers@file');
      expect(chain(labels, router)).toContain('shop-ratelimit@docker');
    }
  });

  test('OIDC is on 443 and on nothing else', () => {
    // Deliberate, not an omission: OIDC is an interactive browser redirect and
    // the extra ports carry machine traffic — an S3 client cannot follow one, so
    // attaching it there would make the port unusable rather than protected.
    const labels = generateTraefikLabelsForApp(
      'shop',
      'shop.example.com',
      ROUTES,
      true,
      undefined,
      true,
    );
    expect(chain(labels, 'shop-secure')).toContain('global-oidc@file');
    expect(chain(labels, 'shop-p1-secure')).not.toContain('global-oidc@file');
    // The WebSocket router follows the 443 route, chain included.
    expect(chain(labels, 'shop-secure-ws')).toEqual(chain(labels, 'shop-secure'));
  });

  test('per-application OIDC is on 443 only too', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', ROUTES, true, {
      authType: 'oidc',
      authConfig: OIDC_CONFIG,
    });
    expect(chain(labels, 'shop-secure')).toContain('shop-oidc@docker');
    expect(chain(labels, 'shop-p1-secure')).not.toContain('shop-oidc@docker');
  });

  test('the health check probes the 443 service alone', () => {
    // One path for the whole application. Probing the web UI's health path
    // against the S3 API would 404, and Traefik would take that port down for a
    // reason that has nothing to do with it.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', ROUTES, true, {
      healthCheckPath: '/health',
    });
    expect(labels['traefik.http.services.shop.loadbalancer.healthcheck.path']).toBe('/health');
    expect(labels['traefik.http.services.shop-p1.loadbalancer.healthcheck.path']).toBeUndefined();
  });

  test('no second WebSocket router', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', ROUTES);
    expect(labels['traefik.http.routers.shop-p1-secure-ws.rule']).toBeUndefined();
  });
});

describe('generateTraefikLabelsForApp — middleware chain', () => {
  test('puts the WAF first, before anything can answer the request', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000);
    expect(chain(labels)).toEqual(['crowdsec@file', 'security-headers@file']);
  });

  test('appends global OIDC when the worker has it', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, undefined, true);
    expect(chain(labels)).toEqual(['crowdsec@file', 'security-headers@file', 'global-oidc@file']);
  });

  test('authType "none" opts an app out of global OIDC', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, { authType: 'none' }, true);
    expect(chain(labels)).not.toContain('global-oidc@file');
  });

  test('useGlobalAuth false opts an app out of global OIDC', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, { useGlobalAuth: false }, true);
    expect(chain(labels)).not.toContain('global-oidc@file');
  });

  test('per-app OIDC replaces global OIDC rather than stacking with it', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      authType: 'oidc',
      authConfig: OIDC_CONFIG,
    }, true);

    expect(chain(labels)).not.toContain('global-oidc@file');
    expect(chain(labels)).toContain('shop-oidc@docker');
  });

  test('rate limiting sits after the WAF and before auth', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      rateLimitAvg: 10,
    }, true);

    expect(chain(labels)).toEqual([
      'crowdsec@file',
      'security-headers@file',
      'shop-ratelimit@docker',
      'global-oidc@file',
    ]);
    expect(labels['traefik.http.middlewares.shop-ratelimit.ratelimit.average']).toBe('10');
    expect(labels['traefik.http.middlewares.shop-ratelimit.ratelimit.burst']).toBe('20');
  });

  test('the websocket router carries the same chain as the main one', () => {
    // Its rule matches on two request headers any client can send, so a chain
    // that skipped authentication here made `Connection: Upgrade` a bypass.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      rateLimitAvg: 10,
      authType: 'oidc',
      authConfig: OIDC_CONFIG,
    }, true);

    expect(chain(labels, 'shop-secure-ws')).toEqual(chain(labels));
  });

  test('the websocket router authenticates under global OIDC too', () => {
    // The old filter matched any middleware whose name contained `-oidc`, which
    // caught `global-oidc@file` as well as the per-app one.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, undefined, true);
    expect(chain(labels, 'shop-secure-ws')).toContain('global-oidc@file');
  });

  test('a public app leaves the websocket router unauthenticated', () => {
    // Opting out of auth still has to mean opting out on both routers.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      authType: 'none',
    }, true);
    expect(chain(labels, 'shop-secure-ws')).toEqual(['crowdsec@file', 'security-headers@file']);
  });
});

describe('generateTraefikLabelsForApp — per-app OIDC plugin config', () => {
  const prefix = 'traefik.http.middlewares.shop-oidc.plugin.traefik-oidc-auth';

  function oidcLabels(extra: Partial<typeof OIDC_CONFIG> = {}) {
    return generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      authType: 'oidc',
      authConfig: { ...OIDC_CONFIG, ...extra },
    });
  }

  test('reduces a discovery URL to the issuer, as the worker-level config does', () => {
    // Per-app OIDC is stored as an opaque JSON blob rather than a column, so
    // this render is the only place the value can be corrected.
    const labels = oidcLabels({
      providerURL: 'https://idp.example.com/realms/x/.well-known/openid-configuration',
    });
    expect(labels[`${prefix}.Provider.Url`]).toBe('https://idp.example.com/realms/x');
  });

  test('uses the traefik-oidc-auth key path and PascalCase options', () => {
    const labels = oidcLabels();
    expect(labels[`${prefix}.Provider.Url`]).toBe('https://idp.example.com');
    expect(labels[`${prefix}.Provider.ClientId`]).toBe('shop-client');
    expect(labels[`${prefix}.Provider.UsePkce`]).toBe('true');
    expect(labels[`${prefix}.Secret`]).toHaveLength(32);
  });

  test('defaults to a relative callback on the app s own host', () => {
    // Per-app OIDC must NOT use the worker's shared auth.<base> callback: that
    // host carries the global middleware and a different client registration.
    expect(oidcLabels()[`${prefix}.CallbackUri`]).toBe('/oidc/callback');
  });

  test('honours an explicit callback path', () => {
    expect(oidcLabels({ callbackURL: '/custom/cb' })[`${prefix}.CallbackUri`]).toBe('/custom/cb');
  });

  test('defaults scopes and allows overriding them', () => {
    const defaults = oidcLabels();
    expect(defaults[`${prefix}.Scopes[0]`]).toBe('openid');
    expect(defaults[`${prefix}.Scopes[1]`]).toBe('profile');
    expect(defaults[`${prefix}.Scopes[2]`]).toBe('email');

    const custom = oidcLabels({ scopes: ['openid', 'groups'] });
    expect(custom[`${prefix}.Scopes[1]`]).toBe('groups');
    expect(custom[`${prefix}.Scopes[2]`]).toBeUndefined();
  });

  test('re-checks claims on every request', () => {
    // Without this, a session minted before a claim changed keeps its access.
    expect(oidcLabels()[`${prefix}.Authorization.CheckOnEveryRequest`]).toBe('true');
  });

  test('maps allowedUsers onto an email claim assertion', () => {
    const labels = oidcLabels({ allowedUsers: ['a@x.com', 'b@x.com'] });
    expect(labels[`${prefix}.Authorization.AssertClaims[0].Name`]).toBe('email');
    expect(labels[`${prefix}.Authorization.AssertClaims[0].AnyOf[0]`]).toBe('a@x.com');
    expect(labels[`${prefix}.Authorization.AssertClaims[0].AnyOf[1]`]).toBe('b@x.com');
  });

  test('emits no claim assertion when no users are listed', () => {
    expect(oidcLabels()[`${prefix}.Authorization.AssertClaims[0].Name`]).toBeUndefined();
  });

  test('maps excludedURLs onto a single bypass rule', () => {
    const labels = oidcLabels({ excludedURLs: ['/health', '/public'] });
    expect(labels[`${prefix}.BypassAuthenticationRule`]).toBe(
      'PathPrefix(`/health`) || PathPrefix(`/public`)'
    );
  });

  test('drops an exclusion path that would close the matcher and add rule logic', () => {
    // Each path lands inside a backtick-quoted PathPrefix(). A backtick in the
    // value ends the matcher, so this turned "exclude one path" into "bypass
    // authentication for every GET".
    const labels = oidcLabels({
      excludedURLs: ['/health', '/x`) || Method(`GET'],
    });
    const rule = labels[`${prefix}.BypassAuthenticationRule`];
    expect(rule).toBe('PathPrefix(`/health`)');
    expect(rule).not.toContain('Method');
  });

  test('emits no bypass rule at all when every path is rejected', () => {
    // Rather than an empty `PathPrefix()`, which Traefik would reject and take
    // the whole middleware down with it.
    const labels = oidcLabels({ excludedURLs: ['not-absolute', '/a b'] });
    expect(labels[`${prefix}.BypassAuthenticationRule`]).toBeUndefined();
  });
});

describe('isPlainPathPrefix', () => {
  test('accepts ordinary absolute paths', () => {
    for (const path of ['/', '/health', '/api/v1/status', '/a-b_c.d/~x', '/%20encoded']) {
      expect(isPlainPathPrefix(path), path).toBe(true);
    }
  });

  test('rejects anything that is not an absolute path', () => {
    for (const path of ['health', '', 'http://x/y', ' /health']) {
      expect(isPlainPathPrefix(path), path).toBe(false);
    }
  });

  test('rejects the characters Traefik reads as rule syntax', () => {
    for (const path of ['/x`', "/x'", '/x"', '/x(', '/x)', '/x|', '/x&', '/x,', '/x y', '/x\\y']) {
      expect(isPlainPathPrefix(path), path).toBe(false);
    }
  });

  test('rejects non-strings', () => {
    expect(isPlainPathPrefix(undefined)).toBe(false);
    expect(isPlainPathPrefix(null)).toBe(false);
    expect(isPlainPathPrefix(42)).toBe(false);
  });
});

describe('renderGlobalOidcConfig', () => {
  const rendered = renderGlobalOidcConfig('apps.example.com', {
    providerURL: 'https://idp.example.com',
    clientID: 'rudder-worker',
    clientSecret: 's3cr3t',
    secret: 'a'.repeat(32),
  });
  const doc = Bun.YAML.parse(rendered) as any;
  const mw = doc.http.middlewares['global-oidc'].plugin['traefik-oidc-auth'];

  test('substitutes every placeholder', () => {
    expect(rendered).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
  });

  test('uses one absolute callback URL for the whole worker', () => {
    // This is what makes a single IdP registration cover every application.
    expect(mw.CallbackUri).toBe('https://auth.apps.example.com/oidc/callback');
  });

  test('shares the session cookie across every subdomain', () => {
    expect(mw.SessionCookie.Domain).toBe('.apps.example.com');
    expect(mw.SessionCookie.Secure).toBe(true);
    expect(mw.SessionCookie.HttpOnly).toBe(true);
  });

  test('re-checks claims on every request, because the cookie is shared', () => {
    expect(mw.Authorization.CheckOnEveryRequest).toBe(true);
  });

  test('carries a 32-character secret', () => {
    expect(String(mw.Secret)).toHaveLength(32);
  });

  test('reduces a stored discovery URL to the issuer', () => {
    // Rows written before the field was validated still hold discovery URLs,
    // and the plugin appends the path itself — so shipping one verbatim gives
    // the provider a doubled path and a 404 on the first login attempt. Fixed
    // here as well as on save so a re-provision repairs an existing worker.
    const doc = Bun.YAML.parse(
      renderGlobalOidcConfig('apps.example.com', {
        providerURL: 'https://idp.example.com/realms/x/.well-known/openid-configuration',
        clientID: 'rudder-worker',
        clientSecret: 's3cr3t',
        secret: 'a'.repeat(32),
      }),
    ) as any;
    expect(doc.http.middlewares['global-oidc'].plugin['traefik-oidc-auth'].Provider.Url).toBe(
      'https://idp.example.com/realms/x',
    );
  });

  test('booleans deserialise as booleans, not strings', () => {
    expect(typeof mw.Provider.UsePkce).toBe('boolean');
    expect(typeof mw.SessionCookie.Secure).toBe('boolean');
    expect(typeof mw.Authorization.CheckOnEveryRequest).toBe('boolean');
  });

  test('routes the callback host through a service-less router', () => {
    const router = doc.http.routers['global-oidc-callback'];
    expect(router.rule).toBe('Host(`auth.apps.example.com`)');
    expect(router.service).toBe('noop@internal');
    expect(router.middlewares).toEqual(['global-oidc']);
    expect(router.tls.certResolver).toBe('letsencrypt');
  });

  function callbackUriFor(callbackPath: string | null | undefined): string {
    const doc = Bun.YAML.parse(
      renderGlobalOidcConfig('apps.example.com', {
        providerURL: 'https://idp.example.com',
        clientID: 'rudder-worker',
        clientSecret: 's3cr3t',
        secret: 'a'.repeat(32),
        callbackPath,
      }),
    ) as any;
    return doc.http.middlewares['global-oidc'].plugin['traefik-oidc-auth'].CallbackUri;
  }

  test('honours a callback path the identity provider already has registered', () => {
    // Providers compare redirect URIs by exact string; /oauth2/callback is the
    // other common convention, and a mismatch fails at the IdP, not here.
    expect(callbackUriFor('/oauth2/callback')).toBe('https://auth.apps.example.com/oauth2/callback');
  });

  test('falls back to the default path when none is set or the stored one is junk', () => {
    const expected = 'https://auth.apps.example.com/oidc/callback';
    expect(callbackUriFor(null)).toBe(expected);
    expect(callbackUriFor('')).toBe(expected);
    // A path that slipped past validation must not produce a broken CallbackUri
    // — that would make the middleware unbuildable and cost Traefik the whole file.
    expect(callbackUriFor('oauth2/callback')).toBe(expected);
    expect(callbackUriFor('/cb?next=x')).toBe(expected);
  });
});

describe('identity headers', () => {
  const oidcConfig = {
    providerURL: 'https://idp.example.com',
    clientID: 'rudder-worker',
    clientSecret: 's3cr3t',
    secret: 'a'.repeat(32),
  };

  function headersOf(middleware: string, apps: AppTokenForwarding[] = []): any[] {
    const doc = Bun.YAML.parse(
      renderGlobalOidcConfig('apps.example.com', oidcConfig, apps),
    ) as any;
    return doc.http.middlewares[middleware]?.plugin['traefik-oidc-auth'].Headers;
  }

  test('every application under worker OIDC gets the identity headers', () => {
    const names = headersOf('global-oidc').map((h) => h.Name);
    expect(names).toEqual([
      'X-Forwarded-User',
      'X-Forwarded-Email',
      'X-Forwarded-Preferred-Username',
      'X-Forwarded-Groups',
    ]);
  });

  test('never sets Authorization on its own', () => {
    // An application that uses that header for its own API tokens would find
    // them replaced on every request. It has to be asked for by name.
    expect(headersOf('global-oidc').map((h) => h.Name)).not.toContain('Authorization');
  });

  test('wraps every template so Traefik passes it to the plugin verbatim', () => {
    // Traefik runs dynamic configuration files through text/template before
    // parsing them. An unescaped {{ .claims.email }} is evaluated by Traefik,
    // against a context with no claims, and the plugin receives "".
    for (const header of headersOf('global-oidc')) {
      const value = header.Value ?? header.Values;
      expect(value).toStartWith('{{`');
      expect(value).toEndWith('`}}');
      // A backtick inside would close the raw string literal early and turn the
      // rest into Traefik template syntax.
      expect(value.slice(3, -3)).not.toContain('`');
    }
  });

  test('a claim the provider did not send renders empty, not "<no value>"', () => {
    // Go prints a missing map key as `<no value>`, and an application would
    // create an account named that.
    for (const header of headersOf('global-oidc')) {
      expect(header.Value ?? header.Values).toContain('{{ with ');
    }
  });

  test('groups use Values, so an empty list deletes the header', () => {
    const groups = headersOf('global-oidc').find((h) => h.Name === 'X-Forwarded-Groups');
    // The plugin deletes a header whose Values render to an empty array; with
    // `Value` it would be set to the empty string and any client-supplied
    // leftover under that name would merely be blanked, not removed.
    expect(groups.Value).toBeUndefined();
    expect(groups.Values).toContain('mapToJsonArray');
    expect(groups.Values).toContain('[]');
  });
});

describe('token forwarding', () => {
  const oidcConfig = {
    providerURL: 'https://idp.example.com',
    clientID: 'rudder-worker',
    clientSecret: 's3cr3t',
    secret: 'a'.repeat(32),
  };

  function render(apps: AppTokenForwarding[]): any {
    return Bun.YAML.parse(renderGlobalOidcConfig('apps.example.com', oidcConfig, apps));
  }

  test('defines nothing extra when no application asked for its tokens', () => {
    expect(Object.keys(render([]).http.middlewares)).toEqual(['global-oidc']);
  });

  test('gives an application that asked a copy of the whole middleware', () => {
    const doc = render([{ routerBase: 'shop', idTokenHeader: 'X-Auth-Request-Id-Token' }]);
    const shared = doc.http.middlewares['global-oidc'].plugin['traefik-oidc-auth'];
    const copy = doc.http.middlewares['shop-oidc-tokens'].plugin['traefik-oidc-auth'];

    // Same client, same Secret, same cookie: the copy accepts the session any
    // other application on the worker established.
    expect(copy.Secret).toBe(shared.Secret);
    expect(copy.Provider).toEqual(shared.Provider);
    expect(copy.CallbackUri).toBe(shared.CallbackUri);
    expect(copy.SessionCookie).toEqual(shared.SessionCookie);

    // The headers are the only difference.
    expect(copy.Headers).toEqual([
      ...shared.Headers,
      { Name: 'X-Auth-Request-Id-Token', Value: '{{`{{ .idToken }}`}}' },
    ]);
  });

  test('sends only the tokens that were named', () => {
    const doc = render([{ routerBase: 'shop', accessTokenHeader: 'X-Token' }]);
    const headers = doc.http.middlewares['shop-oidc-tokens'].plugin['traefik-oidc-auth'].Headers;
    const added = headers.filter((h: any) => !h.Name.startsWith('X-Forwarded-'));
    expect(added).toEqual([{ Name: 'X-Token', Value: '{{`{{ .accessToken }}`}}' }]);
  });

  test('prefixes the scheme for Authorization and nothing else', () => {
    const doc = render([
      { routerBase: 'shop', idTokenHeader: 'Authorization', accessTokenHeader: 'X-Token' },
    ]);
    const headers = doc.http.middlewares['shop-oidc-tokens'].plugin['traefik-oidc-auth'].Headers;
    const by = (name: string) => headers.find((h: any) => h.Name === name).Value;
    expect(by('Authorization')).toBe('{{`Bearer {{ .idToken }}`}}');
    expect(by('X-Token')).toBe('{{`{{ .accessToken }}`}}');
  });

  test('one copy per application, and only for the ones that asked', () => {
    const doc = render([
      { routerBase: 'shop', idTokenHeader: 'X-Id' },
      { routerBase: 'blog', accessTokenHeader: 'X-Access' },
    ]);
    expect(Object.keys(doc.http.middlewares).sort()).toEqual([
      'blog-oidc-tokens',
      'global-oidc',
      'shop-oidc-tokens',
    ]);
  });

  test('drops a header name that would not survive as configuration', () => {
    // These are rejected where they are saved, so reaching the renderer means a
    // row written before that validation existed. An unusable `Name:` makes the
    // plugin fail to build, which costs every application on the worker its
    // routing — not just this one.
    const doc = render([
      { routerBase: 'shop', idTokenHeader: 'X-Bad"\nName: evil', accessTokenHeader: 'X-Good' },
    ]);
    const headers = doc.http.middlewares['shop-oidc-tokens'].plugin['traefik-oidc-auth'].Headers;
    const added = headers.filter((h: any) => !h.Name.startsWith('X-Forwarded-'));
    expect(added).toEqual([{ Name: 'X-Good', Value: '{{`{{ .accessToken }}`}}' }]);
  });

  test('an application whose names are all unusable gets no copy at all', () => {
    // A middleware defined but never referenced is only clutter; the danger is
    // the reverse, and `usesGlobalOidc` keeps the two decisions in one place.
    const doc = render([{ routerBase: 'shop', idTokenHeader: 'Cookie' }]);
    expect(Object.keys(doc.http.middlewares)).toEqual(['global-oidc']);
  });

  test('the router still names the middleware the renderer defined', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 3000, true, {
      tokenHeaders: { idTokenHeader: 'X-Id' },
    }, true);
    expect(labels['traefik.http.routers.shop-secure.middlewares']).toContain('shop-oidc-tokens@file');
    expect(labels['traefik.http.routers.shop-secure.middlewares']).not.toContain('global-oidc@file');
  });

  test('an application that asked for nothing keeps the shared middleware', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 3000, true, {}, true);
    expect(labels['traefik.http.routers.shop-secure.middlewares']).toContain('global-oidc@file');
    expect(labels['traefik.http.routers.shop-secure.middlewares']).not.toContain('-oidc-tokens');
  });

  test('a public application gets neither, however its headers are set', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 3000, true, {
      authType: 'none',
      tokenHeaders: { idTokenHeader: 'X-Id' },
    }, true);
    expect(labels['traefik.http.routers.shop-secure.middlewares']).not.toContain('oidc');
  });

  test('per-application OIDC wins: there is no worker session to describe', () => {
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 3000, true, {
      authType: 'oidc',
      authConfig: {
        providerURL: 'https://idp.example.com',
        clientID: 'c',
        clientSecret: 's',
        sessionEncryptionKey: 'a'.repeat(32),
      },
      tokenHeaders: { idTokenHeader: 'X-Id' },
    }, true);
    const chain = labels['traefik.http.routers.shop-secure.middlewares'];
    expect(chain).toContain('shop-oidc@docker');
    expect(chain).not.toContain('shop-oidc-tokens');
    expect(chain).not.toContain('global-oidc@file');
  });

  test('the WebSocket router carries the same middleware as the main one', () => {
    // Two request headers must not be a way to skip authentication — or, here,
    // to reach the application without the identity the copy adds.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 3000, true, {
      tokenHeaders: { idTokenHeader: 'X-Id' },
    }, true);
    expect(labels['traefik.http.routers.shop-secure-ws.middlewares']).toBe(
      labels['traefik.http.routers.shop-secure.middlewares'],
    );
  });
});

describe('generateProvisioningScript', () => {
  const script = generateProvisioningScript('worker-1', {
    baseDomain: 'apps.example.com',
    bouncerKey: 'bouncer-key',
    oidcConfig: {
      providerURL: 'https://idp.example.com',
      clientID: 'rudder-worker',
      clientSecret: 's3cr3t',
      secret: 'a'.repeat(32),
    },
    sshPort: 2222,
  });

  test('leaves no unsubstituted placeholder', () => {
    expect(script).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
  });

  test('the global-oidc.yml it writes carries the per-application middlewares', () => {
    // Provisioning records the worker as applied, so the file it writes has to
    // contain every middleware the routers will name. Omitting them left a
    // re-provisioned labels-mode worker 404ing its token-forwarding apps, with
    // nothing to indicate the push was incomplete.
    const withTokens = generateProvisioningScript('worker-1', {
      baseDomain: 'apps.example.com',
      oidcConfig: {
        providerURL: 'https://idp.example.com',
        clientID: 'rudder-worker',
        clientSecret: 's3cr3t',
        secret: 'a'.repeat(32),
      },
      oidcTokenApps: [{ routerBase: 'shop', idTokenHeader: 'X-Id' }],
    });
    const yml = (source: string) =>
      Buffer.from(
        source.match(/echo "([^"]*)" \| base64 -d > \/etc\/traefik\/dynamic\/global-oidc\.yml/)![1],
        'base64',
      ).toString();

    expect(yml(withTokens)).toContain('shop-oidc-tokens:');
    expect(yml(script)).not.toContain('-oidc-tokens:');
  });

  test('the WAF middleware does not refuse traffic when AppSec cannot answer', () => {
    // The bouncer plugin defaults to blocking when the AppSec server is
    // unreachable or erroring, and this middleware is first in every router's
    // chain — so with the defaults, every application on the worker returned
    // 403 to everyone for as long as CrowdSec was not answering. Applying a
    // rule exclusion restarts CrowdSec, so that window was reached by using
    // Rudder as intended, and nothing in Rudder could show it: a bouncer-side
    // 403 is not a decision and appears in no `cscli` output.
    const crowdsecYml = Buffer.from(
      script.match(/echo "([^"]*)" \| base64 -d > \/etc\/traefik\/dynamic\/crowdsec\.yml/)![1],
      'base64',
    ).toString();

    expect(crowdsecYml).toContain('crowdsecAppsecUnreachableBlock: false');
    expect(crowdsecYml).toContain('crowdsecAppsecFailureBlock: false');
    // And only the head of a body is inspected. The default is 10 MB, buffered
    // in Traefik and run through CRS under a 10-second timeout, which turned
    // file uploads into 403s for the uploader.
    expect(crowdsecYml).toContain('crowdsecAppsecBodyLimit: 65536');
  });

  test('preserves Go template syntax used by podman commands', () => {
    // The substitution regex must not eat `{{.Names}}` / `{{.Status}}`.
    expect(script).toContain('{{.Names}}');
    expect(script).toContain('{{.Status}}');
  });

  describe('worker identity token', () => {
    // The credential /api/workers/register uses to tell which worker is calling.
    // It has to be planted in both routing modes: that endpoint serves both, and
    // only minting it for http-mode workers left every default worker unable to
    // ever register.
    test('is written in labels mode, where there is no routing config at all', () => {
      const labels = generateProvisioningScript('worker-1', {
        baseDomain: 'apps.example.com',
        workerToken: 'deadbeef',
      });

      expect(labels).toContain('WORKER_TOKEN=deadbeef');
      expect(labels).toContain('/etc/rudder/worker.env');
      // And not via traefik-config.env, which a labels-mode run deletes.
      expect(labels).toContain('rm -f /etc/rudder/traefik-config.env');
    });

    test('is written in http mode too, alongside the routing config', () => {
      const http = generateProvisioningScript('worker-1', {
        baseDomain: 'apps.example.com',
        workerToken: 'deadbeef',
        routingConfig: { endpoint: 'https://rudder.example.com/x', token: 'deadbeef' },
      });

      expect(http).toContain('WORKER_TOKEN=deadbeef');
      expect(http).toContain('CONFIG_TOKEN=deadbeef');
    });

    test('is kept out of a world-readable file', () => {
      const labels = generateProvisioningScript('worker-1', { workerToken: 'deadbeef' });
      expect(labels).toContain('chmod 600 /etc/rudder/worker.env');
    });
  });

  describe('control-plane Basic credentials', () => {
    const withBasic = (basicUser?: string | null, basicPassword?: string | null) =>
      generateProvisioningScript('worker-1', {
        workerToken: 'deadbeef',
        routingConfig: {
          endpoint: 'https://rudder.example.com/x',
          token: 'deadbeef',
          basicUser,
          basicPassword,
        },
      });

    test('are written to the fetch environment when configured', () => {
      const script = withBasic('proxyuser', 'proxypass');
      expect(script).toContain("CONFIG_BASIC_USER='proxyuser'");
      expect(script).toContain("CONFIG_BASIC_PASS='proxypass'");
    });

    test('are shell-quoted, because the file they land in is sourced', () => {
      // Unquoted, a password like this leaves an unmatched double quote in
      // traefik-config.env; `. "$ENV_FILE"` then fails and the worker stops
      // fetching entirely, for a reason that shows up nowhere near the field
      // it was typed into.
      const script = withBasic('user2', 'pa"ss\\word');
      expect(script).toContain(`CONFIG_BASIC_PASS='pa"ss\\word'`);
    });

    test('a single quote in the password is escaped, not terminated', () => {
      const script = withBasic('user2', "it's");
      expect(script).toContain(`CONFIG_BASIC_PASS='it'\\''s'`);
    });

    test('are absent entirely when not configured', () => {
      // Not "written as empty": the fetch script branches on the username being
      // set, and an empty one would send `Authorization: Basic :` instead of the
      // bearer token — turning a working worker into a 401.
      const script = withBasic(null, null);
      expect(script).not.toContain('CONFIG_BASIC_USER=proxyuser');
      expect(script).toContain('if [ -n "" ]; then');
    });

    test('land in the same 600 file as the token', () => {
      expect(withBasic('u', 'p')).toContain('chmod 600 /etc/rudder/traefik-config.env');
    });
  });

  test('embeds every required config blob', () => {
    // A missing template variable renders as an empty string, which would
    // silently produce `echo "" | base64 -d > <file>` and an empty config.
    for (const target of [
      '/etc/traefik/traefik.yml',
      '/etc/traefik/dynamic/crowdsec.yml',
      '/etc/crowdsec/acquis.yaml',
      '/etc/containers/registries.conf',
    ]) {
      expect(script).not.toContain(`echo "" | base64 -d > ${target}`);
    }
  });

  /** Decode a base64 blob `source` writes to `target`. */
  function blobIn(source: string, target: string): string {
    const m = source.match(new RegExp(`echo "([^"]*)" \\| base64 -d > ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    if (!m) throw new Error(`no blob written to ${target}`);
    return Buffer.from(m[1], 'base64').toString('utf-8');
  }

  /** Decode a base64 blob the script writes to `target`. */
  function blobFor(target: string): string {
    return blobIn(script, target);
  }

  test('installs every AppSec config the acquisition references', () => {
    // The CrowdSec container re-fetches the hub on every start and does not
    // persist /etc/crowdsec, so an appsec_config that is not in COLLECTIONS is
    // simply absent at boot. CrowdSec then exits fatally — "no appsec-config
    // found" — and restarts forever, taking the WAF down with it. Verified on a
    // live worker.
    const acquis = blobFor('/etc/crowdsec/acquis.d/appsec.yaml');
    const unit = blobFor('/etc/systemd/system/crowdsec-container.service');
    const collections = unit.match(/COLLECTIONS=([^"]*)/)![1].split(/\s+/);

    const configs = [...acquis.matchAll(/^\s*-\s*(crowdsecurity\/\S+)$/gm)].map((m) => m[1]);
    expect(configs).toContain('crowdsecurity/crs');

    for (const config of configs) {
      const collection =
        config === 'crowdsecurity/crs'
          ? 'crowdsecurity/appsec-crs'
          : config === 'crowdsecurity/appsec-default'
            ? null // ships with the image
            : config;
      if (collection) expect(collections).toContain(collection);
    }
  });

  describe('per-application rule exclusions', () => {
    // `rudder/exclusions` is the one appsec_config that is *not* a hub item, so
    // the test above cannot cover it. It arrives by bind mount instead, and the
    // failure mode is the same one that test documents: an appsec_config the
    // acquisition names but CrowdSec cannot find is a fatal start, forever, with
    // the WAF down.
    test('the acquisition names it and the container is given a file for it', () => {
      const acquis = blobFor('/etc/crowdsec/acquis.d/appsec.yaml');
      const unit = blobFor('/etc/systemd/system/crowdsec-container.service');

      expect(acquis).toContain('- rudder/exclusions');
      expect(unit).toContain(
        '/etc/rudder/appsec/rudder-exclusions.yaml:/etc/crowdsec/appsec-configs/rudder-exclusions.yaml',
      );
    });

    test('the file exists before the container that mounts it starts', () => {
      // Podman creates a *directory* at a bind-mount source that does not
      // exist, and CrowdSec then fails to load the config the acquisition names.
      const created = script.indexOf('/etc/rudder/appsec/rudder-exclusions.yaml <<');
      const started = script.indexOf('systemctl start crowdsec-container.service');
      expect(created).toBeGreaterThan(-1);
      expect(started).toBeGreaterThan(created);
    });

    test('the placeholder it writes is a config CrowdSec can load', () => {
      // An empty file is not a valid appsec-config, and "no exclusions" is the
      // resting state of almost every worker — so the placeholder has to be a
      // real document, not a touch.
      const at = script.indexOf('/etc/rudder/appsec/rudder-exclusions.yaml <<');
      const open = script.indexOf('RXEOF', at);
      const close = script.indexOf('RXEOF', open + 'RXEOF'.length);
      expect(script.slice(open, close)).toContain('name: rudder/exclusions');
    });

    test('the fetch timer is installed in labels mode too', () => {
      // Which CRS rules an application is exempt from has nothing to do with
      // how Traefik learns its routes. Gating this on http mode would leave
      // every default worker unable to ever apply an exclusion.
      const labels = generateProvisioningScript('worker-1', {
        baseDomain: 'apps.example.com',
        workerToken: 'deadbeef',
        appsecConfig: { endpoint: 'https://rudder.example.com/a', token: 'deadbeef' },
      });
      expect(labels).not.toContain('CONFIG_ENDPOINT=https');
      expect(labels).toContain('systemctl enable --now rudder-appsec-config.timer');
      expect(labels).toContain('APPSEC_ENDPOINT=https://rudder.example.com/a');
    });

    test('the token it plants is not world-readable', () => {
      const withEndpoint = generateProvisioningScript('worker-1', {
        appsecConfig: { endpoint: 'https://rudder.example.com/a', token: 'deadbeef' },
      });
      expect(withEndpoint).toContain('chmod 600 /etc/rudder/appsec-config.env');
    });

    test('no endpoint disables the timer rather than leaving it fetching nothing', () => {
      const none = generateProvisioningScript('worker-1', { baseDomain: 'apps.example.com' });
      expect(none).toContain('systemctl disable --now rudder-appsec-config.timer');
    });
  });

  test('opens the configured SSH port in the firewall', () => {
    expect(script).toContain('local SSH_PORT="2222"');
  });

  describe('Podman API route', () => {
    test('requires a verified client certificate when there is a base domain', () => {
      const routing = blobFor('/etc/traefik/dynamic/podman-api.yml');
      expect(routing).toContain('Host(`podman-api.apps.example.com`)');
      expect(routing).toContain('clientAuthType: RequireAndVerifyClientCert');
      expect(routing).toContain('options: podman-mtls');
    });

    test('is not published at all without a base domain', () => {
      // There used to be a "notls" variant for this case: a catch-all
      // ``PathPrefix(`/`)`` router with no clientAuth block. Traefik listens on
      // 443 and the firewall admits 443, so it published the root-equivalent
      // Podman API to anyone who could reach the worker — `POST
      // /containers/create` with a privileged bind mount of `/` is host
      // takeover. It cannot be secured in place, because Traefik binds
      // tls.options to a router's SNI and a catch-all has no host to bind to.
      const noDomain = generateProvisioningScript('worker-1', { bouncerKey: 'k' });

      // The blob is empty, so the guard around the write is not taken and the
      // stale file from any earlier run is removed instead.
      expect(blobIn(noDomain, '/etc/traefik/dynamic/podman-api.yml')).toBe('');
      expect(noDomain).toContain('rm -f /etc/traefik/dynamic/podman-api.yml');
      expect(noDomain).not.toContain('PathPrefix(`/`)');
    });

    test('never claims mTLS on a run that did not configure it', () => {
      // This line was unconditional, so the operator was told the Podman API was
      // "secured with mTLS client certificate authentication" on exactly the
      // runs where it was not secured at all.
      const noDomain = generateProvisioningScript('worker-1', { bouncerKey: 'k' });
      expect(noDomain).toContain('Podman API NOT published');
    });
  });

  test('lets containers reach aardvark-dns on the bridge gateway', () => {
    // The input chain is traversed by container→host traffic, so without these
    // two rules every application on the worker loses DNS: name resolution
    // between services, and outbound requests by hostname. Verified on a live
    // worker — removing them breaks `nslookup` in any container on a
    // user-defined network, which is every container Rudder deploys.
    expect(script).toContain('iifname "podman*" meta l4proto { tcp, udp } th dport 53 accept');
    expect(script).toContain('iifname "cni-podman*" meta l4proto { tcp, udp } th dport 53 accept');
  });

  test('keeps the host services blocked from the bridges', () => {
    // The DNS exception must stay an exception. Nothing may accept container
    // traffic to the Podman API, the CrowdSec LAPI or the metrics endpoint.
    for (const port of ['8080', '8081', '7422', '9100', '6060']) {
      expect(script).not.toContain(`th dport ${port} accept`);
      expect(script).not.toContain(`tcp dport ${port} accept`);
    }
  });

  test('treats the firewall as non-fatal but reports it when skipped', () => {
    // It must not abort provisioning on a host without nftables, but it also
    // must not disappear silently — a worker with no firewall used to report
    // complete success.
    expect(script).toContain('soft_step "firewall" step_firewall');
    expect(script).toContain('STEP_SKIP:${name}');
  });

  test('hard-fails on steps the worker cannot run without', () => {
    for (const critical of ['podman', 'mtls-certs', 'podman-api', 'traefik-config']) {
      expect(script).toContain(`step "${critical}" step_`);
    }
  });

  test('falls back to port 22 when none is given', () => {
    const noPort = generateProvisioningScript('worker-1', {
      baseDomain: 'apps.example.com',
      bouncerKey: 'bouncer-key',
    });
    expect(noPort).toContain('local SSH_PORT="22"');
  });

  const EMPTY_OIDC_BLOB = 'echo "" | base64 -d > /etc/traefik/dynamic/global-oidc.yml';

  test('writes the global OIDC middleware when OIDC is configured', () => {
    expect(script).not.toContain(EMPTY_OIDC_BLOB);
  });

  test('omits the global OIDC middleware when OIDC is not configured', () => {
    const noOidc = generateProvisioningScript('worker-1', {
      baseDomain: 'apps.example.com',
      bouncerKey: 'bouncer-key',
    });
    expect(noOidc).toContain(EMPTY_OIDC_BLOB);
    expect(noOidc).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
  });

  // ── Patching, pinning and patch reporting (2-05) ──────────────────────────

  test('re-provisioning installs pending updates by default', () => {
    // provision.sh had no `apt-get upgrade` anywhere and step_podman
    // short-circuits on `command -v podman`, so a re-provision refreshed
    // configuration and left the host's packages a year behind.
    expect(script).toContain('soft_step "updates" step_updates');
    expect(script).toContain('unattended-upgrade -v');
    // The flag is substituted, so the rendered guard is what to assert on.
    expect(script).toContain('if [ "1" != "1" ]');
  });

  test('the flag turns installation off while still reporting what is pending', () => {
    const noUpdates = generateProvisioningScript('worker-1', {
      baseDomain: 'apps.example.com',
      bouncerKey: 'bouncer-key',
      applyUpdates: false,
    });
    expect(noUpdates).toContain('if [ "0" != "1" ]');
    expect(noUpdates).toContain('Update installation is disabled for this run — reporting only');
    // The count is computed before the flag is consulted.
    expect(noUpdates).toContain('Pending package updates:');
  });

  test('passes conffile options on the command line, not into global apt config', () => {
    // As a global Dpkg::Options this would silently answer conffile prompts
    // for an administrator's own interactive apt run too.
    expect(script).toContain("-o 'Dpkg::Options::=--force-confold'");
    const conf = blobFor('/etc/apt/apt.conf.d/51rudder-unattended');
    expect(conf).not.toContain('Dpkg::Options {');
  });

  test('brings the -updates pocket into unattended-upgrades, which is what covers podman', () => {
    const conf = blobFor('/etc/apt/apt.conf.d/51rudder-unattended');
    expect(conf).toContain('${distro_id}:${distro_codename}-updates');
    expect(conf).toContain('${distro_id}:${distro_codename}-security');
  });

  test('never reboots a worker on its own', () => {
    const conf = blobFor('/etc/apt/apt.conf.d/51rudder-unattended');
    expect(conf).toContain('Unattended-Upgrade::Automatic-Reboot "false"');
    expect(script).not.toMatch(/^\s*(reboot|shutdown -r)\b/m);
  });

  test('platform images are pinned, and the pin comes from PLATFORM_IMAGES', () => {
    expect(script).toContain(`CROWDSEC_VERSION="${PLATFORM_IMAGES.crowdsec.version}"`);
    expect(script).toContain(`TRAEFIK_VERSION="${PLATFORM_IMAGES.traefik.version}"`);
    expect(script).not.toContain('TRAEFIK_VERSION="latest"');
    expect(script).not.toContain('CROWDSEC_VERSION="latest"');
  });

  test('pulls before pinning the unit, so the digest is the one this run fetched', () => {
    const pullAt = script.indexOf('podman pull docker.io/traefik');
    const digestAt = script.indexOf('resolve_image_digest "$traefik_ref"');
    const sedAt = script.indexOf('s|docker.io/traefik:TRAEFIK_VERSION_PLACEHOLDER|');
    expect(pullAt).toBeGreaterThan(-1);
    expect(digestAt).toBeGreaterThan(pullAt);
    expect(sedAt).toBeGreaterThan(digestAt);
  });

  test('an unreachable GitHub does not silently downgrade a plugin', () => {
    // The old fallback replaced whatever was installed with a hardcoded older
    // version — a security control moving backwards with nothing in the log.
    expect(script).toContain('keeping the installed version');
    expect(script).toContain('refusing to continue');
    expect(script).not.toContain('get_latest_github_tag "maxlerebourg/crowdsec-bouncer-traefik-plugin" "v1.6.0"');
  });

  test('containers with a restart policy come back after the worker reboots', () => {
    // Podman is daemonless: a restart policy is enforced by conmon while the
    // host is up and by nothing across a reboot. Traefik and CrowdSec returned
    // because they have units; every application Rudder deployed did not.
    expect(script).toContain('systemctl enable --now rudder-container-boot.service');

    const unit = blobFor('/etc/systemd/system/rudder-container-boot.service');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain('ExecStart=/usr/local/bin/rudder-container-boot.sh start');
    // A oneshot without RemainAfterExit reads as inactive the moment it
    // finishes, and its ExecStop would then never run.
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('ExecStop=/usr/local/bin/rudder-container-boot.sh stop');
  });

  test('the boot script covers unless-stopped, which podman-restart.service does not', () => {
    const boot = blobFor('/usr/local/bin/rudder-container-boot.sh');
    expect(boot).toContain('restart-policy=$policy');
    expect(boot).toContain('POLICIES=(always unless-stopped)');
    // Neither Docker nor podman-restart.service starts these at boot, and a
    // container that exits non-zero on every start would spin from power-on.
    expect(boot).not.toContain('on-failure)');
  });

  test('does not leave podman-restart.service racing the Rudder unit', () => {
    // It covers `always` only, so it cannot replace ours — and two things
    // starting the same containers is how a boot ends in half-started state.
    const disableAt = script.indexOf('systemctl disable --now podman-restart.service');
    const enableAt = script.indexOf('systemctl enable --now rudder-container-boot.service');
    expect(disableAt).toBeGreaterThan(-1);
    expect(enableAt).toBeGreaterThan(disableAt);
  });

  test('installs the patch-state scan on its own daily timer', () => {
    // apt-get -s upgrade takes seconds and holds the apt lock; it has no
    // business on the 30-second metrics timer.
    expect(script).toContain('systemctl enable --now rudder-updates.timer');
    const timer = blobFor('/etc/systemd/system/rudder-updates.timer');
    expect(timer).toContain('OnUnitActiveSec=1d');
    const metricsTimer = blobFor('/etc/systemd/system/rudder-metrics.timer');
    expect(metricsTimer).not.toContain('1d');
  });

  test('the metrics collector reads the cache instead of running apt itself', () => {
    const collector = blobFor('/usr/local/bin/rudder-metrics.sh');
    expect(collector).toContain('/var/lib/rudder/updates.json');
    // No apt invocation on this path — only the comment explaining why.
    expect(collector).not.toMatch(/^\s*apt-get/m);
    expect(collector).not.toMatch(/\$\(\s*apt-get/);
  });

  test('a worker with no scan reports nothing rather than zero', () => {
    // Zero would read as "fully patched" for a host nobody has scanned.
    const collector = blobFor('/usr/local/bin/rudder-metrics.sh');
    expect(collector).toContain('patch_state=""');
    expect(collector).not.toContain('"updates_pending":0');
  });

  test('exposes Traefik metrics on loopback only, behind the mTLS host', () => {
    const traefikYml = blobFor('/etc/traefik/traefik.yml');
    expect(traefikYml).toContain('address: "127.0.0.1:8082"');
    expect(traefikYml).toContain('addRoutersLabels: true');
    // The metrics entryPoint in particular must never be bound publicly. The
    // firewall would drop it anyway; an entryPoint that only ever listens on
    // loopback cannot be re-exposed by a firewall mistake.
    expect(traefikYml).not.toMatch(/address: ":8082"/);

    const metricsRouting = blobFor('/etc/traefik/dynamic/metrics.yml');
    expect(metricsRouting).toContain('options: podman-mtls');
    expect(metricsRouting).toContain('/prometheus');
  });

  /** Public entryPoint ports from the rendered traefik.yml, ascending. */
  function traefikPublicPorts(source = script): number[] {
    const parsed = Bun.YAML.parse(blobIn(source, '/etc/traefik/traefik.yml')) as {
      entryPoints: Record<string, { address: string }>;
    };
    return Object.values(parsed.entryPoints)
      .map((e) => e.address)
      .filter((a) => !a.startsWith('127.0.0.1'))
      .map((a) => Number(a.replace(/^:/, '')))
      .sort((a, b) => a - b);
  }

  /** Ports the nftables rule accepts, ascending, deduplicated. */
  function firewallPorts(source = script): number[] {
    const m = source.match(/for p in ([^;]+); do/);
    if (!m) throw new Error('firewall port list not found');
    const ports = m[1]
      .split(/\s+/)
      .map((t) => Number(t.replace(/["$A-Z_]/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
    return [...new Set(ports)].sort((a, b) => a - b);
  }

  test('binds five public HTTPS entryPoints, 443 first', () => {
    // 443 is index 0 and cannot be anything else: ACME's TLS-ALPN-01 challenge
    // is served there and nowhere else, so a hostname with no router on 443
    // never obtains the certificate the other entryPoints would serve.
    const traefikYml = blobFor('/etc/traefik/traefik.yml');
    const parsed = Bun.YAML.parse(traefikYml) as {
      entryPoints: Record<string, { address: string }>;
    };
    expect(parsed.entryPoints.websecure.address).toBe(':443');
    for (const i of [1, 2, 3, 4]) {
      expect(parsed.entryPoints[`websecure-${i}`].address).toBe(`:${i}443`);
    }
    expect(traefikPublicPorts()).toEqual([443, 1443, 2443, 3443, 4443]);
  });

  test('the firewall admits exactly the ports Traefik binds, plus SSH', () => {
    // The check that matters is the agreement, not either list on its own. A
    // port Traefik binds but nftables drops presents as an application that
    // does not answer, which is indistinguishable from an application bug and
    // is not one; a port the firewall opens with nothing behind it is exposure
    // bought for nothing.
    //
    // 22 is the difference between the two sets, and the only one allowed.
    const traefik = traefikPublicPorts();
    const firewall = firewallPorts();
    expect(firewall).toEqual([22, ...traefik].sort((a, b) => a - b));

    // The rule is fed by that list and not by a second hand-written one.
    expect(script).toContain('tcp dport { ${ACCEPT_PORTS} } accept');

    // The loopback-only entryPoint is in neither set.
    expect(firewall).not.toContain(8082);
  });

  test('cannot emit a duplicate element when SSH runs on an HTTPS port', () => {
    // nftables rejects a repeated element in an anonymous set and refuses the
    // whole ruleset — and the failure path then deletes the table, so a
    // duplicate does not misconfigure the firewall, it removes it. The SSH port
    // is operator input and is the only value that can collide.
    // The deduplication itself runs in bash on the worker, so what is assertable
    // here is that the SSH port goes through it rather than being concatenated
    // into the set: the old code special-cased 22 and 443 by hand, which is
    // exactly the shape that missed 1443-4443 when they were added.
    for (const sshPort of [22, 443, 2443, 2222]) {
      const rendered = generateProvisioningScript('worker-1', {
        bouncerKey: 'k',
        baseDomain: 'example.com',
        sshPort,
      });
      expect(rendered).toContain(`local SSH_PORT="${sshPort}"`);
      expect(rendered.match(/for p in ([^;]+); do/)![1]).toContain('"$SSH_PORT"');
      expect(rendered).toContain('*",${p},"*) continue ;;');
      // No hand-built set survives anywhere.
      expect(rendered).not.toContain('SSH_PORTS');
      // The literal ports Traefik binds are unaffected by the SSH port.
      expect(firewallPorts(rendered)).toEqual([22, 443, 1443, 2443, 3443, 4443]);
    }
  });

  test('omits it when the worker has no base domain to build a callback host from', () => {
    // Without a base domain there is no auth.<base> callback host, so the
    // middleware could not be built — shipping a broken one would make Traefik
    // discard the whole dynamic file.
    const noDomain = generateProvisioningScript('worker-1', {
      bouncerKey: 'bouncer-key',
      oidcConfig: {
        providerURL: 'https://idp.example.com',
        clientID: 'rudder-worker',
        clientSecret: 's3cr3t',
        secret: 'a'.repeat(32),
      },
    });
    expect(noDomain).toContain(EMPTY_OIDC_BLOB);
  });
});
