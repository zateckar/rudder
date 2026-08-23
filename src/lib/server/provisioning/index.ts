import { routerName } from '../domains';
import { OIDC_CALLBACK_PATH, resolveCallbackPath } from '../oidc';

// Shell assets imported as raw strings (Vite inlines at build time)
import provisionShTemplate from './shell/provision.sh?raw';

// Config templates
import traefikYmlTemplate from './shell/templates/traefik.yml?raw';
import podmanApiRoutingTlsTemplate from './shell/templates/podman-api-routing-tls.yml?raw';
import metricsRoutingTemplate from './shell/templates/metrics-routing.yml?raw';
import crowdsecMiddlewareTemplate from './shell/templates/crowdsec-middleware.yml?raw';
import globalOidcMiddlewareTemplate from './shell/templates/global-oidc-middleware.yml?raw';
import crowdsecAcquisTemplate from './shell/templates/crowdsec-acquis.yml?raw';
import crowdsecAppsecAcquisTemplate from './shell/templates/crowdsec-appsec-acquis.yml?raw';
import crowdsecConfigLocalTemplate from './shell/templates/crowdsec-config-local.yml?raw';
import registriesTemplate from './shell/templates/registries.conf?raw';
import unattendedUpgradesTemplate from './shell/templates/unattended-upgrades.conf?raw';

// Helper scripts
import crowdsecRegisterSh from './shell/scripts/rudder-crowdsec-register.sh?raw';
import netavarkCleanupSh from './shell/scripts/rudder-netavark-cleanup.sh?raw';
import metricsSh from './shell/scripts/rudder-metrics.sh?raw';
import metricsHttpSh from './shell/scripts/rudder-metrics-http.sh?raw';
import traefikConfigSh from './shell/scripts/rudder-traefik-config.sh?raw';
import updatesSh from './shell/scripts/rudder-updates.sh?raw';

// Systemd units
import podmanApiSocketUnit from './shell/units/podman-api-socket.service?raw';
import podmanApiTcpUnit from './shell/units/podman-api-tcp.service?raw';
import traefikContainerUnit from './shell/units/traefik-container.service?raw';
import crowdsecContainerUnit from './shell/units/crowdsec-container.service?raw';
import crowdsecRegisterUnit from './shell/units/rudder-crowdsec-register.service?raw';
import netavarkCleanupUnit from './shell/units/rudder-netavark-cleanup.service?raw';
import netavarkCleanupTimerUnit from './shell/units/rudder-netavark-cleanup.timer?raw';
import metricsUnit from './shell/units/rudder-metrics.service?raw';
import metricsTimerUnit from './shell/units/rudder-metrics.timer?raw';
import metricsHttpUnit from './shell/units/rudder-metrics-http.service?raw';
import traefikConfigUnit from './shell/units/rudder-traefik-config.service?raw';
import traefikConfigTimerUnit from './shell/units/rudder-traefik-config.timer?raw';
import updatesUnit from './shell/units/rudder-updates.service?raw';
import updatesTimerUnit from './shell/units/rudder-updates.timer?raw';

/**
 * Replace {{UPPER_SNAKE_CASE}} placeholders in a template string.
 * Only matches UPPER_SNAKE_CASE patterns to avoid colliding with
 * Go template syntax like {{.Status}} used by podman commands.
 */
function replacePlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, key) => {
    return key in vars ? vars[key] : '';
  });
}

function toBase64(content: string): string {
  return Buffer.from(content).toString('base64');
}

/**
 * Container images this control plane installs on a worker.
 *
 * Pinned rather than `latest`: provisioning pulls unconditionally, so a
 * floating tag turns any re-provision into an unplanned upgrade — a Traefik
 * major version can arrive during a run triggered to change something
 * unrelated. Moving a version here is a reviewable diff, and the worker page
 * compares these against what a worker is actually running so an operator can
 * see when a re-provision would change something.
 *
 * The exact bytes are pinned further at provisioning time: the tag is resolved
 * to a repo digest after the pull and that digest goes into the systemd unit.
 */
export const PLATFORM_IMAGES = {
  traefik: { repo: 'docker.io/traefik', version: 'v3.7.10' },
  crowdsec: { repo: 'docker.io/crowdsecurity/crowdsec', version: 'v1.7.8' },
} as const;

export type PlatformComponent = keyof typeof PLATFORM_IMAGES;

/** Worker-level OIDC settings, already decrypted. */
export interface GlobalOidcConfig {
  providerURL: string;
  clientID: string;
  clientSecret: string;
  /** The plugin's `Secret` — must be exactly 32 characters. */
  secret: string;
  /**
   * Path of the shared callback URL. Defaults to `OIDC_CALLBACK_PATH`; set it
   * to whatever the worker's IdP client has registered, since providers match
   * redirect URIs by exact string.
   */
  callbackPath?: string | null;
}

/**
 * Render `/etc/traefik/dynamic/global-oidc.yml` for a worker.
 *
 * Single source of truth for the global OIDC middleware: used both when
 * provisioning a worker from scratch and when pushing a config change to a
 * running worker over SSH, so the two can never drift apart.
 */
export function renderGlobalOidcConfig(
  baseDomain: string,
  oidcConfig: GlobalOidcConfig,
): string {
  return replacePlaceholders(globalOidcMiddlewareTemplate, {
    BASE_DOMAIN: baseDomain,
    OIDC_PROVIDER_URL: oidcConfig.providerURL,
    OIDC_CLIENT_ID: oidcConfig.clientID,
    OIDC_CLIENT_SECRET: oidcConfig.clientSecret,
    OIDC_SECRET: oidcConfig.secret,
    OIDC_CALLBACK_PATH: resolveCallbackPath(oidcConfig.callbackPath),
  });
}

export interface ProvisioningOptions {
  baseDomain?: string;
  bouncerKey?: string;
  oidcConfig?: GlobalOidcConfig;
  /** SSH port to keep open in the host firewall alongside 22. */
  sshPort?: number;
  /**
   * Install pending host package updates during this run. Defaults to true —
   * re-provisioning should be a patching event, not a config refresh that
   * leaves a year-old kernel in place.
   *
   * Turning it off still reports what is pending; it only skips the install,
   * for environments that patch on their own schedule and for runs where the
   * extra minutes matter.
   */
  applyUpdates?: boolean;
  /**
   * Routing configuration delivery, for workers in `http` routing mode. When
   * absent the worker stays on container labels and any previously installed
   * routes.yml is removed — the two must never both define a router.
   */
  routingConfig?: {
    /** Absolute URL of this worker's config endpoint on the control plane. */
    endpoint: string;
    /** Bearer token, already decrypted. */
    token: string;
  };
  /**
   * This worker's own credential, planted regardless of routing mode.
   *
   * `POST /api/workers/register` needs it to tell which worker is calling — the
   * shared registration secret says only that the caller is *some* worker, and
   * the endpoint picks its target from the hostname in the body. It is the same
   * value as `routingConfig.token` when there is one; it gets its own file
   * because `traefik-config.env` is deleted on a labels-mode run, and workers in
   * both modes register.
   */
  workerToken?: string;
}

export function generateProvisioningScript(
  workerName: string,
  options: ProvisioningOptions = {},
): string {
  const {
    baseDomain,
    bouncerKey: bouncerKeyParam,
    oidcConfig,
    sshPort,
    routingConfig,
    workerToken,
    applyUpdates = true,
  } = options;
  const bouncerKey = bouncerKeyParam || '';
  const podmanApiDomain = baseDomain ? `podman-api.${baseDomain}` : '';
  const acmeEmail = baseDomain ? `admin@${baseDomain}` : `admin@${workerName}.local`;

  // Template variables for {{PLACEHOLDER}} substitution
  const templateVars: Record<string, string> = {
    ACME_EMAIL: acmeEmail,
    BOUNCER_KEY: bouncerKey,
    BASE_DOMAIN: baseDomain || '',
    PODMAN_API_DOMAIN: podmanApiDomain,
    WORKER_NAME: workerName,
  };

  // Render config templates with runtime values
  const traefikYml = replacePlaceholders(traefikYmlTemplate, templateVars);
  // No base domain means no Podman API route at all.
  //
  // There used to be a "notls" variant here for that case: a catch-all
  // ``PathPrefix(`/`)`` router, `tls: {}`, and — crucially — no `clientAuth`
  // block. Traefik listens on 443 and the host firewall admits 443, so every
  // worker provisioned without a base domain published the root-equivalent
  // Podman API to anyone who could reach it. `POST /containers/create` with a
  // privileged bind mount of `/` is host takeover.
  //
  // It cannot be fixed in place: Traefik binds `tls.options` to a router's SNI,
  // and a catch-all has no Host rule to bind to, so `RequireAndVerifyClientCert`
  // there is silently ignored or applied to every connection. Without a
  // hostname there is nothing to route, so nothing is routed — the API stays on
  // 127.0.0.1:8080 for local use. `/api/workers/provision` refuses these
  // workers up front; this is the second layer, so the insecure document cannot
  // be generated even by a caller that bypasses the route.
  const podmanApiRouting = baseDomain
    ? replacePlaceholders(podmanApiRoutingTlsTemplate, templateVars)
    : '';
  const metricsRouting = baseDomain
    ? replacePlaceholders(metricsRoutingTemplate, templateVars)
    : '';
  const crowdsecMiddleware = replacePlaceholders(crowdsecMiddlewareTemplate, templateVars);
  const globalOidcMiddleware = (oidcConfig && baseDomain)
    ? renderGlobalOidcConfig(baseDomain, oidcConfig)
    : '';

  // Render scripts/units that need variable substitution
  const crowdsecRegister = replacePlaceholders(crowdsecRegisterSh, templateVars);
  const crowdsecContainer = replacePlaceholders(crowdsecContainerUnit, templateVars);

  // Build provision.sh placeholder map
  const provisionVars: Record<string, string> = {
    WORKER_NAME: workerName,
    BOUNCER_KEY: bouncerKey,
    BASE_DOMAIN: baseDomain || '',
    SSH_PORT: String(sshPort && sshPort > 0 ? sshPort : 22),
    CONFIG_ENDPOINT: routingConfig?.endpoint ?? '',
    CONFIG_TOKEN: routingConfig?.token ?? '',
    WORKER_TOKEN: workerToken ?? '',
    APPLY_UPDATES: applyUpdates ? '1' : '0',
    TRAEFIK_IMAGE_VERSION: PLATFORM_IMAGES.traefik.version,
    CROWDSEC_IMAGE_VERSION: PLATFORM_IMAGES.crowdsec.version,

    // Config templates (base64-encoded)
    TRAEFIK_YML_B64: toBase64(traefikYml),
    PODMAN_API_ROUTING_B64: podmanApiRouting ? toBase64(podmanApiRouting) : '',
    METRICS_ROUTING_B64: metricsRouting ? toBase64(metricsRouting) : '',
    CROWDSEC_MIDDLEWARE_B64: toBase64(crowdsecMiddleware),
    GLOBAL_OIDC_MIDDLEWARE_B64: globalOidcMiddleware ? toBase64(globalOidcMiddleware) : '',
    CROWDSEC_ACQUIS_B64: toBase64(crowdsecAcquisTemplate),
    CROWDSEC_APPSEC_ACQUIS_B64: toBase64(crowdsecAppsecAcquisTemplate),
    CROWDSEC_CONFIG_LOCAL_B64: toBase64(crowdsecConfigLocalTemplate),
    REGISTRIES_B64: toBase64(registriesTemplate),
    UNATTENDED_UPGRADES_B64: toBase64(unattendedUpgradesTemplate),

    // Systemd units (base64-encoded)
    PODMAN_API_SOCKET_SERVICE_B64: toBase64(podmanApiSocketUnit),
    PODMAN_API_TCP_SERVICE_B64: toBase64(podmanApiTcpUnit),
    TRAEFIK_SERVICE_B64: toBase64(traefikContainerUnit),
    CROWDSEC_SERVICE_B64: toBase64(crowdsecContainer),
    CROWDSEC_REGISTER_SERVICE_B64: toBase64(crowdsecRegisterUnit),
    NETAVARK_CLEANUP_SERVICE_B64: toBase64(netavarkCleanupUnit),
    NETAVARK_CLEANUP_TIMER_B64: toBase64(netavarkCleanupTimerUnit),
    METRICS_SERVICE_B64: toBase64(metricsUnit),
    METRICS_TIMER_B64: toBase64(metricsTimerUnit),
    METRICS_HTTP_SERVICE_B64: toBase64(metricsHttpUnit),
    TRAEFIK_CONFIG_SERVICE_B64: toBase64(traefikConfigUnit),
    TRAEFIK_CONFIG_TIMER_B64: toBase64(traefikConfigTimerUnit),
    UPDATES_SERVICE_B64: toBase64(updatesUnit),
    UPDATES_TIMER_B64: toBase64(updatesTimerUnit),

    // Helper scripts (base64-encoded)
    CROWDSEC_REGISTER_SCRIPT_B64: toBase64(crowdsecRegister),
    NETAVARK_CLEANUP_SCRIPT_B64: toBase64(netavarkCleanupSh),
    METRICS_SCRIPT_B64: toBase64(metricsSh),
    METRICS_HTTP_SCRIPT_B64: toBase64(metricsHttpSh),
    TRAEFIK_CONFIG_SCRIPT_B64: toBase64(traefikConfigSh),
    UPDATES_SCRIPT_B64: toBase64(updatesSh),
  };

  return replacePlaceholders(provisionShTemplate, provisionVars);
}

// ── Traefik label generation ──────────────────────────────────────────
// Generate Podman/Docker labels for Traefik routing with HTTPS, Let's Encrypt TLS-ALPN-01, and CrowdSec WAF
// Traefik listens on port 443 only. No port 80 needed.
// Traefik runs with host networking so it proxies to host-mapped container ports via 127.0.0.1
// All routes are protected by CrowdSec AppSec middleware (crowdsec@file) by default.
// Per-application rate limiting and OIDC auth can be added via options.
export interface AppMiddlewareOptions {
  rateLimitAvg?: number;      // requests/second average (Traefik rateLimit)
  rateLimitBurst?: number;    // max burst size
  authType?: 'none' | 'oidc';
  authConfig?: {              // Per-app OIDC provider settings
    providerURL: string;      // e.g. https://accounts.google.com
    clientID: string;
    clientSecret: string;
    /** Plugin `Secret` — must be exactly 32 characters. */
    sessionEncryptionKey: string;
    /**
     * Callback path on the application's own host.  Per-app OIDC deliberately
     * does *not* use the worker's shared `auth.<base>` callback: that host
     * carries the global middleware and a different IdP client.
     */
    callbackURL?: string;     // default: /oidc/callback
    /**
     * Not supported by the plugin — `AssertClaims` matches claim values by
     * exact string equality, with no suffix or pattern matching.  Deploys that
     * set this are rejected rather than silently losing the restriction.
     */
    allowedUserDomains?: string[];
    allowedUsers?: string[];  // → Authorization.AssertClaims on the `email` claim
    excludedURLs?: string[];  // → BypassAuthenticationRule (PathPrefix)
    scopes?: string[];
  };
  healthCheckPath?: string;   // Traefik health check endpoint, e.g. /health
  useGlobalAuth?: boolean;    // whether to apply global OIDC auth (default: true if global OIDC is configured)
}

/**
 * Is this an absolute URL path safe to place inside a Traefik matcher?
 *
 * Must start with `/`, and may not contain a backtick (which would close the
 * matcher), whitespace, or the characters Traefik's rule grammar reads as
 * operators and grouping. Deliberately narrow: this guards a value that becomes
 * authentication logic.
 */
export function isPlainPathPrefix(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    path.length <= 2048 &&
    !/[`'"()|&,\s\\]/.test(path)
  );
}

export function generateTraefikLabelsForApp(
  appName: string,
  domain: string,
  targetPort: number,
  enableWebSocket: boolean = true,
  middlewareOpts?: AppMiddlewareOptions,
  globalOidcEnabled: boolean = false
): Record<string, string> {
  const safeName = routerName(appName);

  // Build middleware chain: crowdsec first, then security headers
  const middlewares: string[] = ['crowdsec@file', 'security-headers@file'];

  const labels: Record<string, string> = {
    'traefik.enable': 'true',

    // HTTPS router with Let's Encrypt TLS-ALPN-01 (no port 80 needed)
    [`traefik.http.routers.${safeName}-secure.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${safeName}-secure.entrypoints`]: 'websecure',
    [`traefik.http.routers.${safeName}-secure.tls`]: 'true',
    [`traefik.http.routers.${safeName}-secure.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.routers.${safeName}-secure.service`]: safeName,

    // Service: Traefik on host network proxies to container's host-mapped port
    [`traefik.http.services.${safeName}.loadbalancer.server.url`]: `http://127.0.0.1:${targetPort}`,
  };

  // Health check — Traefik marks backend as down if it fails
  if (middlewareOpts?.healthCheckPath) {
    labels[`traefik.http.services.${safeName}.loadbalancer.healthcheck.path`] = middlewareOpts.healthCheckPath;
    labels[`traefik.http.services.${safeName}.loadbalancer.healthcheck.interval`] = '10s';
    labels[`traefik.http.services.${safeName}.loadbalancer.healthcheck.timeout`] = '5s';
  }

  // Per-app rate limiting (Traefik built-in rateLimit middleware)
  if (middlewareOpts?.rateLimitAvg && middlewareOpts.rateLimitAvg > 0) {
    const rlName = `${safeName}-ratelimit`;
    labels[`traefik.http.middlewares.${rlName}.ratelimit.average`] = String(middlewareOpts.rateLimitAvg);
    labels[`traefik.http.middlewares.${rlName}.ratelimit.burst`] = String(middlewareOpts.rateLimitBurst || middlewareOpts.rateLimitAvg * 2);
    labels[`traefik.http.middlewares.${rlName}.ratelimit.period`] = '1s';
    middlewares.push(`${rlName}@docker`);
  }

  // Global OIDC auth (if enabled and not overridden by per-app OIDC or explicitly disabled)
  const hasPerAppOidc = middlewareOpts?.authType === 'oidc' && middlewareOpts.authConfig;
  const isPublicApp = middlewareOpts?.authType === 'none';
  const useGlobalAuth = middlewareOpts?.useGlobalAuth !== false;

  if (globalOidcEnabled && !hasPerAppOidc && !isPublicApp && useGlobalAuth) {
    middlewares.push('global-oidc@file');
  }

  // Per-app OIDC auth (sevensolutions/traefik-oidc-auth plugin).
  //
  // Unlike the worker-global middleware this uses a *relative* CallbackUri, so
  // the plugin intercepts /oidc/callback on the application's own host.  The
  // shared auth.<base> host belongs to the global middleware and a different
  // IdP client registration.
  if (middlewareOpts?.authType === 'oidc' && middlewareOpts.authConfig) {
    const oidcName = `${safeName}-oidc`;
    const cfg = middlewareOpts.authConfig;
    const p = `traefik.http.middlewares.${oidcName}.plugin.traefik-oidc-auth`;

    labels[`${p}.LogLevel`] = 'INFO';
    labels[`${p}.Secret`] = cfg.sessionEncryptionKey;
    labels[`${p}.Provider.Url`] = cfg.providerURL;
    labels[`${p}.Provider.ClientId`] = cfg.clientID;
    labels[`${p}.Provider.ClientSecret`] = cfg.clientSecret;
    labels[`${p}.Provider.UsePkce`] = 'true';
    labels[`${p}.CallbackUri`] = cfg.callbackURL || OIDC_CALLBACK_PATH;
    labels[`${p}.SessionCookie.Secure`] = 'true';
    labels[`${p}.SessionCookie.HttpOnly`] = 'true';
    labels[`${p}.SessionCookie.SameSite`] = 'lax';

    const scopes = cfg.scopes?.length ? cfg.scopes : ['openid', 'profile', 'email'];
    scopes.forEach((scope, i) => {
      labels[`${p}.Scopes[${i}]`] = scope;
    });

    // Claim assertions are only re-evaluated per request when asked; without
    // this a session minted before a claim changed keeps its access.
    labels[`${p}.Authorization.CheckOnEveryRequest`] = 'true';
    if (cfg.allowedUsers?.length) {
      labels[`${p}.Authorization.AssertClaims[0].Name`] = 'email';
      cfg.allowedUsers.forEach((u, i) => {
        labels[`${p}.Authorization.AssertClaims[0].AnyOf[${i}]`] = u;
      });
    }

    // excludedURLs are path prefixes; the plugin takes a single Traefik-style rule.
    //
    // Each path goes inside a backtick-quoted matcher, so an unfiltered value
    // could close it and append rule logic of its own: a path of
    // `` /x`) || Method(`GET `` turned a path exclusion into "bypass
    // authentication for every GET". Anything that is not a plain absolute path
    // is dropped rather than escaped — there is no legitimate exclusion that
    // needs these characters, and a silently rewritten rule is worse than a
    // missing one.
    if (cfg.excludedURLs?.length) {
      const paths = cfg.excludedURLs.filter(isPlainPathPrefix);
      if (paths.length !== cfg.excludedURLs.length) {
        console.warn(
          `[traefik] Dropped ${cfg.excludedURLs.length - paths.length} OIDC exclusion path(s) for ` +
            `"${safeName}" that were not plain absolute paths.`,
        );
      }
      if (paths.length) {
        labels[`${p}.BypassAuthenticationRule`] = paths
          .map((path) => `PathPrefix(\`${path}\`)`)
          .join(' || ');
      }
    }

    middlewares.push(`${oidcName}@docker`);
  }

  // Set the middleware chain on the router
  const middlewareChain = middlewares.join(',');
  labels[`traefik.http.routers.${safeName}-secure.middlewares`] = middlewareChain;

  if (enableWebSocket) {
    labels[`traefik.http.routers.${safeName}-secure-ws.rule`] =
      `Host(\`${domain}\`) && Header(\`Connection\`, \`Upgrade\`) && Header(\`Upgrade\`, \`websocket\`)`;
    labels[`traefik.http.routers.${safeName}-secure-ws.entrypoints`] = 'websecure';
    labels[`traefik.http.routers.${safeName}-secure-ws.tls`] = 'true';
    labels[`traefik.http.routers.${safeName}-secure-ws.tls.certresolver`] = 'letsencrypt';
    labels[`traefik.http.routers.${safeName}-secure-ws.service`] = safeName;
    // The same chain as the main router, authentication included.
    //
    // This router used to drop every middleware whose name contained `-oidc` —
    // both `global-oidc@file` and the per-app one — on the grounds that a
    // WebSocket client cannot follow an OAuth redirect.  But Traefik picks a
    // router by matching its rule, and this rule matches on two request headers
    // that any HTTP client can send: `Connection: Upgrade` and
    // `Upgrade: websocket` on an ordinary GET reached the application with no
    // session at all, on any method.  Authentication that two headers turn off
    // is not authentication.
    //
    // The redirect concern was real but is the plugin's to make: it answers an
    // unauthenticated non-HTML request with 401 rather than a redirect, which is
    // what a WebSocket client should see.  A browser opening a socket carries
    // the session cookie the page's own login established, so real WebSocket
    // traffic from a signed-in user still passes.
    labels[`traefik.http.routers.${safeName}-secure-ws.middlewares`] = middlewareChain;
  }

  return labels;
}
