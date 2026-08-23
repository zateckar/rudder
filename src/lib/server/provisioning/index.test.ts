import { describe, expect, test } from 'bun:test';
import {
  PLATFORM_IMAGES,
  generateProvisioningScript,
  generateTraefikLabelsForApp,
  isPlainPathPrefix,
  renderGlobalOidcConfig,
  type AppMiddlewareOptions,
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
    // No second public entryPoint: 443 stays the only externally bound port.
    expect(traefikYml).not.toMatch(/address: ":8082"/);

    const metricsRouting = blobFor('/etc/traefik/dynamic/metrics.yml');
    expect(metricsRouting).toContain('options: podman-mtls');
    expect(metricsRouting).toContain('/prometheus');
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
