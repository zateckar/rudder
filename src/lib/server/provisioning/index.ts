import { env } from '../env';

// Shell assets imported as raw strings (Vite inlines at build time)
import provisionShTemplate from './shell/provision.sh?raw';

// Config templates
import traefikYmlTemplate from './shell/templates/traefik.yml?raw';
import podmanApiRoutingTlsTemplate from './shell/templates/podman-api-routing-tls.yml?raw';
import podmanApiRoutingNotlsTemplate from './shell/templates/podman-api-routing-notls.yml?raw';
import metricsRoutingTemplate from './shell/templates/metrics-routing.yml?raw';
import crowdsecMiddlewareTemplate from './shell/templates/crowdsec-middleware.yml?raw';
import globalOidcMiddlewareTemplate from './shell/templates/global-oidc-middleware.yml?raw';
import crowdsecAcquisTemplate from './shell/templates/crowdsec-acquis.yml?raw';
import crowdsecAppsecAcquisTemplate from './shell/templates/crowdsec-appsec-acquis.yml?raw';
import crowdsecConfigLocalTemplate from './shell/templates/crowdsec-config-local.yml?raw';
import registriesTemplate from './shell/templates/registries.conf?raw';

// Helper scripts
import crowdsecRegisterSh from './shell/scripts/rudder-crowdsec-register.sh?raw';
import netavarkCleanupSh from './shell/scripts/rudder-netavark-cleanup.sh?raw';
import metricsSh from './shell/scripts/rudder-metrics.sh?raw';
import metricsHttpSh from './shell/scripts/rudder-metrics-http.sh?raw';

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

export function generateProvisioningScript(
  workerName: string,
  baseDomain?: string,
  bouncerKeyParam?: string,
  oidcConfig?: {
    providerURL: string;
    clientID: string;
    clientSecret: string;
    encryptionKey: string;
  }
): string {
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
    ...(oidcConfig ? {
      OIDC_PROVIDER_URL: oidcConfig.providerURL,
      OIDC_CLIENT_ID: oidcConfig.clientID,
      OIDC_CLIENT_SECRET: oidcConfig.clientSecret,
      OIDC_ENCRYPTION_KEY: oidcConfig.encryptionKey,
    } : {}),
  };

  // Render config templates with runtime values
  const traefikYml = replacePlaceholders(traefikYmlTemplate, templateVars);
  const podmanApiRouting = baseDomain
    ? replacePlaceholders(podmanApiRoutingTlsTemplate, templateVars)
    : podmanApiRoutingNotlsTemplate;
  const metricsRouting = baseDomain
    ? replacePlaceholders(metricsRoutingTemplate, templateVars)
    : '';
  const crowdsecMiddleware = replacePlaceholders(crowdsecMiddlewareTemplate, templateVars);
  const globalOidcMiddleware = (oidcConfig && baseDomain)
    ? replacePlaceholders(globalOidcMiddlewareTemplate, templateVars)
    : '';

  // Render scripts/units that need variable substitution
  const crowdsecRegister = replacePlaceholders(crowdsecRegisterSh, templateVars);
  const crowdsecContainer = replacePlaceholders(crowdsecContainerUnit, templateVars);

  // Build provision.sh placeholder map
  const provisionVars: Record<string, string> = {
    WORKER_NAME: workerName,
    BOUNCER_KEY: bouncerKey,
    BASE_DOMAIN: baseDomain || '',

    // Config templates (base64-encoded)
    TRAEFIK_YML_B64: toBase64(traefikYml),
    PODMAN_API_ROUTING_B64: toBase64(podmanApiRouting),
    METRICS_ROUTING_B64: metricsRouting ? toBase64(metricsRouting) : '',
    CROWDSEC_MIDDLEWARE_B64: toBase64(crowdsecMiddleware),
    GLOBAL_OIDC_MIDDLEWARE_B64: globalOidcMiddleware ? toBase64(globalOidcMiddleware) : '',
    CROWDSEC_ACQUIS_B64: toBase64(crowdsecAcquisTemplate),
    CROWDSEC_APPSEC_ACQUIS_B64: toBase64(crowdsecAppsecAcquisTemplate),
    CROWDSEC_CONFIG_LOCAL_B64: toBase64(crowdsecConfigLocalTemplate),
    REGISTRIES_B64: toBase64(registriesTemplate),

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

    // Helper scripts (base64-encoded)
    CROWDSEC_REGISTER_SCRIPT_B64: toBase64(crowdsecRegister),
    NETAVARK_CLEANUP_SCRIPT_B64: toBase64(netavarkCleanupSh),
    METRICS_SCRIPT_B64: toBase64(metricsSh),
    METRICS_HTTP_SCRIPT_B64: toBase64(metricsHttpSh),
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
  authConfig?: {              // OIDC provider settings
    providerURL: string;      // e.g. https://accounts.google.com
    clientID: string;
    clientSecret: string;
    sessionEncryptionKey: string;
    callbackURL?: string;     // default: /oauth2/callback
    allowedUserDomains?: string[];
    allowedUsers?: string[];
    excludedURLs?: string[];
    scopes?: string[];
  };
  healthCheckPath?: string;   // Traefik health check endpoint, e.g. /health
  useGlobalAuth?: boolean;    // whether to apply global OIDC auth (default: true if global OIDC is configured)
}

export function generateTraefikLabelsForApp(
  appName: string,
  domain: string,
  targetPort: number,
  enableWebSocket: boolean = true,
  middlewareOpts?: AppMiddlewareOptions,
  globalOidcEnabled: boolean = false
): Record<string, string> {
  const safeName = appName.replace(/[^a-zA-Z0-9-]/g, '-');

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

  // Per-app OIDC auth (traefik-oidc plugin)
  if (middlewareOpts?.authType === 'oidc' && middlewareOpts.authConfig) {
    const oidcName = `${safeName}-oidc`;
    const cfg = middlewareOpts.authConfig;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.providerURL`] = cfg.providerURL;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.clientID`] = cfg.clientID;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.clientSecret`] = cfg.clientSecret;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.sessionEncryptionKey`] = cfg.sessionEncryptionKey;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.callbackURL`] = cfg.callbackURL || '/oauth2/callback';
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.forceHTTPS`] = 'true';
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.enablePKCE`] = 'true';
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.logLevel`] = 'info';
    if (cfg.scopes?.length) {
      cfg.scopes.forEach((scope, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.scopes[${i}]`] = scope;
      });
    }
    if (cfg.allowedUserDomains?.length) {
      cfg.allowedUserDomains.forEach((d, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.allowedUserDomains[${i}]`] = d;
      });
    }
    if (cfg.allowedUsers?.length) {
      cfg.allowedUsers.forEach((u, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.allowedUsers[${i}]`] = u;
      });
    }
    if (cfg.excludedURLs?.length) {
      cfg.excludedURLs.forEach((p, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.excludedURLs[${i}]`] = p;
      });
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
    // WebSocket routes get crowdsec + rate limit but NOT oidc (websocket doesn't do OAuth redirects)
    const wsMiddlewares = middlewares.filter(m => !m.includes('-oidc'));
    labels[`traefik.http.routers.${safeName}-secure-ws.middlewares`] = wsMiddlewares.join(',');
  }

  return labels;
}

export function generateTraefikLabelsForApps(
  baseDomain: string,
  apps: Array<{ name: string; subdomain: string; port: number; enableWs?: boolean }>
): Record<string, string> {
  const allLabels: Record<string, string> = {};
  const globalOidcEnabled = !!(env.OIDC_PROVIDER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && baseDomain);
  for (const app of apps) {
    const fullDomain = app.subdomain + '.' + baseDomain;
    const labels = generateTraefikLabelsForApp(app.name, fullDomain, app.port, app.enableWs, undefined, globalOidcEnabled);
    Object.assign(allLabels, labels);
  }
  return allLabels;
}

export function generateTraefikConfig(
  baseDomain: string,
  apps: Array<{ subdomain: string; port: number; enableWs?: boolean }>
): string {
  const routers = apps.map(app => {
    const fullDomain = app.subdomain + '.' + baseDomain;
    return `
    ${app.subdomain}-secure:
      rule: "Host(\`${fullDomain}\`)"
      entrypoints:
        - "websecure"
      tls:
        certResolver: letsencrypt
      middlewares:
        - crowdsec
        - security-headers
      service: "${app.subdomain}"`;
  }).join('\n');

  const services = apps.map(app => `
    ${app.subdomain}:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:${app.port}"`).join('\n');

  return `http:
  routers:
${routers}

  services:
${services}`;
}

export function generateCaddyfile(
  baseDomain: string,
  apps: Array<{ subdomain: string; port: number; enableWs?: boolean }>
): string {
  const appBlocks = apps.map(app => {
    const fullDomain = app.subdomain + '.' + baseDomain;
    const websocketDirectives = app.enableWs ? `
    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websocket localhost:${app.port}
` : '';
    return `${fullDomain} {
    encode zstd gzip
    ${websocketDirectives}
    reverse_proxy localhost:${app.port}
}`;
  }).join('\n\n');

  return `{
    admin off
    auto_https off
}

:443 {
    handle /health {
        respond "OK" 200
    }
    respond "Not configured" 404
}

${appBlocks}
`;
}
