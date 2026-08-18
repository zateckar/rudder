import { describe, expect, test } from 'bun:test';
import {
  PLATFORM_IMAGES,
  generateProvisioningScript,
  generateTraefikLabelsForApp,
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

  test('the websocket router keeps the WAF but drops every OIDC middleware', () => {
    // A websocket upgrade cannot follow an OAuth redirect, so auth is skipped
    // there — but losing the WAF on that route would be a hole.
    const labels = generateTraefikLabelsForApp('shop', 'shop.example.com', 31000, true, {
      rateLimitAvg: 10,
      authType: 'oidc',
      authConfig: OIDC_CONFIG,
    }, true);

    const ws = chain(labels, 'shop-secure-ws');
    expect(ws).toContain('crowdsec@file');
    expect(ws).toContain('security-headers@file');
    expect(ws).toContain('shop-ratelimit@docker');
    expect(ws.some((m) => m.includes('oidc'))).toBe(false);
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

  /** Decode a base64 blob the script writes to `target`. */
  function blobFor(target: string): string {
    const m = script.match(new RegExp(`echo "([^"]*)" \\| base64 -d > ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    if (!m) throw new Error(`no blob written to ${target}`);
    return Buffer.from(m[1], 'base64').toString('utf-8');
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
