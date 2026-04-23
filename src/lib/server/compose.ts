import { parse as parseYaml } from 'yaml';
import { generateTraefikLabelsForApp } from './provisioning';

export interface ComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  ports?: string[] | { target?: number; published?: number; protocol?: string }[];
  volumes?: string[] | { type?: string; source?: string; target?: string; read_only?: boolean }[];
  environment?: Record<string, string> | string[];
  env_file?: string | string[];
  command?: string | string[];
  entrypoint?: string | string[];
  depends_on?: string[] | Record<string, { condition?: string }>;
  restart?: string;
  networks?: string[];
  labels?: Record<string, string>;
  mem_limit?: string | number;
  cpus?: number;
  cpu_shares?: number;
  healthcheck?: {
    test?: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  expose?: string[] | number[];
  external_links?: string[];
  extra_hosts?: string[];
  dns?: string | string[];
  cap_add?: string[];
  cap_drop?: string[];
  privileged?: boolean;
  read_only?: boolean;
  stdin_open?: boolean;
  tty?: boolean;
  user?: string;
  working_dir?: string;
}

export interface ComposeConfig {
  version?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, { driver?: string; external?: boolean }>;
  volumes?: Record<string, { driver?: string; external?: boolean }>;
}

export interface ParsedContainer {
  name: string;
  image: string;
  env: string[];
  ports: Record<string, Array<{ hostPort: string }>>;
  volumes: Record<string, { bind: string; options: string }>;
  restartPolicy: string;
  labels: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  memory?: number;
  cpuShares?: number;
  healthcheck?: {
    test: string[];
    interval?: number;   // nanoseconds
    timeout?: number;     // nanoseconds
    retries?: number;
    startPeriod?: number; // nanoseconds
  };
  networks?: string[];
}

export function parseCompose(manifest: string, appName: string, teamSlug?: string, baseDomain?: string, appId?: string): ParsedContainer[] {
  const config = parseYaml(manifest) as ComposeConfig;
  
  if (!config || !config.services) {
    throw new Error('Invalid compose file: no services defined');
  }

  const appLabel = { app: appName };

  const containers: ParsedContainer[] = [];

  for (const [serviceName, service] of Object.entries(config.services)) {
    const containerName = `${appName}-${appId ? appId.slice(0, 8) + '-' : ''}${serviceName}`;
    
    const env: Record<string, string> = {};
    
    if (service.environment) {
      if (Array.isArray(service.environment)) {
        for (const envEntry of service.environment) {
          const [key, value] = envEntry.split('=');
          if (key) {
            env[key] = value || '';
          }
        }
      } else {
        Object.assign(env, service.environment);
      }
    }

    const ports: Record<string, Array<{ hostPort: string }>> = {};
    
    if (service.ports) {
      for (const portEntry of service.ports) {
        if (typeof portEntry === 'string') {
          const [hostPort, containerPort] = portEntry.split(':');
          ports[`${containerPort}/tcp`] = [{ hostPort }];
        } else if (portEntry.published && portEntry.target) {
          ports[`${portEntry.target}/tcp`] = [{ hostPort: String(portEntry.published) }];
        }
      }
    }

    const volumes: Record<string, { bind: string; options: string }> = {};
    
    if (service.volumes) {
      for (const volumeEntry of service.volumes) {
        if (typeof volumeEntry === 'string') {
          const [source, target, options = 'rw'] = volumeEntry.split(':');
          volumes[source] = { bind: target, options };
        } else if (volumeEntry.source && volumeEntry.target) {
          const options = volumeEntry.read_only ? 'ro' : 'rw';
          volumes[volumeEntry.source] = { bind: volumeEntry.target, options };
        }
      }
    }

    let restartPolicy = 'no';
    if (service.restart) {
      switch (service.restart) {
        case 'always':
        case 'on-failure':
        case 'unless-stopped':
          restartPolicy = service.restart;
          break;
        default:
          restartPolicy = 'no';
      }
    }

    const labels: Record<string, string> = {
      ...appLabel,
      service: serviceName,
    };

    if (teamSlug) {
      labels.team = teamSlug;
    }

    if (service.labels) {
      // Strip any traefik.* labels from user-provided compose to prevent route hijacking
      // (our auto-generated Traefik labels are applied below and should not be overridden)
      const sanitized = Object.fromEntries(
        Object.entries(service.labels as Record<string, string>).filter(
          ([k]) => !k.toLowerCase().startsWith('traefik.')
        )
      );
      Object.assign(labels, sanitized);
    }
    
    // Check if service has ports exposed - if so, add Traefik labels automatically
    const hasExposedPorts = ports && Object.keys(ports).length > 0;
    if (hasExposedPorts && baseDomain) {
      // Get the first port for Traefik routing
      const firstPortKey = Object.keys(ports)[0];
      const firstPortBinding = ports[firstPortKey]?.[0]?.hostPort;
      
      if (firstPortBinding) {
        const fullDomain = `${serviceName}.${appName}.${baseDomain}`;
        const traefikLabels = generateTraefikLabelsForApp(
          serviceName,
          fullDomain,
          parseInt(firstPortBinding),
          true // Enable WebSocket for terminals
        );
        
        // Merge Traefik labels with existing labels
        Object.assign(labels, traefikLabels);
      }
    }

    let memory: number | undefined;
    if (service.mem_limit) {
      if (typeof service.mem_limit === 'number') {
        memory = service.mem_limit;
      } else {
        memory = parseMemory(service.mem_limit);
      }
    }

    let cpuShares: number | undefined;
    if (service.cpu_shares) {
      cpuShares = service.cpu_shares;
    }

    // Parse healthcheck
    let healthcheck: ParsedContainer['healthcheck'];
    if (service.healthcheck) {
      const hc = service.healthcheck;
      let test: string[] = [];
      if (hc.test) {
        if (Array.isArray(hc.test)) {
          test = hc.test;
        } else {
          // Shell form: wrap in CMD-SHELL
          test = ['CMD-SHELL', hc.test];
        }
      }
      healthcheck = {
        test,
        interval: hc.interval ? parseDuration(hc.interval) : undefined,
        timeout: hc.timeout ? parseDuration(hc.timeout) : undefined,
        retries: hc.retries,
        startPeriod: hc.start_period ? parseDuration(hc.start_period) : undefined,
      };
    }

    containers.push({
      name: containerName,
      image: service.image || `${serviceName}:latest`,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ports,
      volumes,
      restartPolicy,
      labels,
      command: service.command ? (Array.isArray(service.command) ? service.command : [service.command]) : undefined,
      entrypoint: service.entrypoint ? (Array.isArray(service.entrypoint) ? service.entrypoint : [service.entrypoint]) : undefined,
      workingDir: service.working_dir,
      memory,
      cpuShares,
      healthcheck,
      networks: service.networks,
    });
  }

  return containers;
}

/** Parse Docker duration string (e.g. "30s", "1m30s", "5m") to nanoseconds */
function parseDuration(dur: string): number {
  let totalMs = 0;
  const parts = dur.match(/(\d+)(h|m|s|ms|us|ns)/g);
  if (!parts) return 0;
  for (const part of parts) {
    const match = part.match(/^(\d+)(h|m|s|ms|us|ns)$/);
    if (!match) continue;
    const val = parseInt(match[1]);
    switch (match[2]) {
      case 'h': totalMs += val * 3600000; break;
      case 'm': totalMs += val * 60000; break;
      case 's': totalMs += val * 1000; break;
      case 'ms': totalMs += val; break;
      case 'us': totalMs += val / 1000; break;
      case 'ns': return val; // already nanoseconds
    }
  }
  return totalMs * 1_000_000; // convert ms to nanoseconds
}

function parseMemory(memStr: string): number {
  const match = memStr.match(/^(\d+)([bBkKmMgG]?)$/);
  if (!match) return 0;
  
  const value = parseInt(match[1], 10);
  const unit = match[2] || 'b';
  
  switch (unit.toLowerCase()) {
    case 'b':
      return value;
    case 'k':
      return value * 1024;
    case 'm':
      return value * 1024 * 1024;
    case 'g':
      return value * 1024 * 1024 * 1024;
    default:
      return value;
  }
}

export function validateCompose(manifest: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  try {
    const config = parseYaml(manifest) as ComposeConfig;
    
    if (!config) {
      errors.push('Invalid YAML');
      return { valid: false, errors };
    }
    
    if (!config.services || Object.keys(config.services).length === 0) {
      errors.push('No services defined');
    }
    
    for (const [name, service] of Object.entries(config.services || {})) {
      if (!service.image && !service.build) {
        errors.push(`Service "${name}" has no image or build defined`);
      }
    }
  } catch (e: any) {
    errors.push(`YAML parse error: ${e.message}`);
  }
  
  return { valid: errors.length === 0, errors };
}
