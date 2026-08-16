import type { MountIntent } from './mounts';
import { ALIAS_LABEL, assertDistinctAliases, networkAliases } from './networks';
import { unreservedPort, type PortAllocator } from './ports';

export interface K8sMetadata {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface K8sPodSpec {
  containers?: K8sContainer[];
  volumes?: K8sVolume[];
  serviceAccountName?: string;
  nodeSelector?: Record<string, string>;
  restartPolicy?: string;
}

export interface K8sContainer {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number; protocol?: string }>;
  env?: Array<{ name: string; value?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
  command?: string[];
  args?: string[];
  workingDir?: string;
}

export interface K8sVolume {
  name: string;
  emptyDir?: Record<string, any>;
  hostPath?: { path: string };
  configMap?: { name: string };
  secret?: { secretName: string };
}

export interface K8sServiceSpec {
  selector?: Record<string, string>;
  ports?: Array<{ port: number; targetPort: number | string; protocol?: string; name?: string }>;
  type?: string;
}

export interface K8sManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: K8sMetadata;
  spec?: K8sPodSpec | K8sServiceSpec;
}

export interface ParsedK8sContainer {
  name: string;
  image: string;
  env: Record<string, string>;
  /**
   * Podman port bindings, keyed `<containerPort>/<protocol>`.
   *
   * The host port is allocated, never taken from the manifest. A Pod spec's
   * `containerPort` describes the port *inside* the container — Kubernetes has
   * no concept of publishing it on the identical host port, and doing so meant
   * two applications that both listened on 80 could not share a worker, and one
   * application could not run two generations at once. Traefik reaches the
   * container through whatever host port it was given, so nothing outside this
   * record needs to know which.
   */
  ports: Record<string, Array<{ hostPort: string }>>;
  /** What the container asked to mount. Policy is applied by the executor. */
  mounts: MountIntent[];
  /**
   * DNS names siblings can reach this container by.
   *
   * A Kubernetes Pod's containers share a network namespace and address each
   * other over `localhost`. Rudder gives each container its own address on a
   * bridge network instead, so they must use each other's names. That is a
   * deliberate deviation from Pod semantics — see the README.
   */
  aliases: string[];
  restartPolicy: string;
  labels: Record<string, string>;
  command?: string[];
  args?: string[];
  workingDir?: string;
  memory?: number;
  cpuShares?: number;
}

export interface ParseK8sOptions {
  /**
   * Allocates a free host port on the target worker. Supplied by the caller so
   * allocation can consult the ports other containers already hold — including
   * the generation being replaced, which is still running during a blue/green
   * deploy. Without it ports are drawn at random, which is only safe when the
   * result is being inspected rather than deployed.
   */
  allocatePort?: PortAllocator;
}

export function parseK8sManifest(
  manifest: string,
  appName: string,
  teamSlug?: string,
  options: ParseK8sOptions = {},
): ParsedK8sContainer[] {
  const allocatePort = options.allocatePort ?? unreservedPort;
  // Detect JSON vs YAML — kubectl manifest is stored as JSON, UI YAML upload is YAML
  const isJson = manifest.trim().startsWith('{') || manifest.trim().startsWith('[{');

  let docs: any[];
  if (isJson) {
    try {
      docs = [JSON.parse(manifest)];
    } catch {
      docs = [];
    }
  } else {
    docs = manifest.split('---').map(doc => Bun.YAML.parse(doc) as any).filter(Boolean);
  }
  
  const containers: ParsedK8sContainer[] = [];
  /** Volumes declared by the Pod spec, by name, as written. */
  const volumes: Record<string, K8sVolume> = {};
  const labels: Record<string, string> = { app: appName };
  if (teamSlug) labels.team = teamSlug;

  for (const doc of docs) {
    if (!doc) continue;
    
    const kind = doc.kind?.toLowerCase();
    const metadata = doc.metadata || {};
    const spec = doc.spec || {};
    
    if (kind === 'pod') {
      const podSpec = spec as K8sPodSpec;
      
      if (podSpec.volumes) {
        for (const vol of podSpec.volumes) volumes[vol.name] = vol;
      }

      if (podSpec.containers) {
        for (const container of podSpec.containers) {
          const parsed = parseK8sContainer(container, metadata, volumes, appName, allocatePort, podSpec.restartPolicy);
          parsed.labels = { ...labels, ...parsed.labels };
          containers.push(parsed);
        }
      }
    } else if (kind === 'deployment') {
      if (spec.template?.spec) {
        const podSpec = spec.template.spec as K8sPodSpec;
        
        if (podSpec.volumes) {
          for (const vol of podSpec.volumes) volumes[vol.name] = vol;
        }

        if (podSpec.containers) {
          for (const container of podSpec.containers) {
            const parsed = parseK8sContainer(container, metadata, volumes, appName, allocatePort, podSpec.restartPolicy);
            // Strip any traefik.* labels from user metadata to prevent route hijacking
            const safeMetaLabels = Object.fromEntries(
              Object.entries(metadata.labels || {}).filter(
                ([k]) => !k.toLowerCase().startsWith('traefik.')
              )
            );
            parsed.labels = {
              ...labels,
              ...safeMetaLabels,
              // Rebuilt rather than merged, so the alias has to be carried over
              // explicitly — a sibling cannot resolve a name that is not here.
              [ALIAS_LABEL]: parsed.aliases[0],
              'app.kubernetes.io/name': container.name,
              'app.kubernetes.io/version': container.image?.split(':')[1] || 'latest',
            };
            containers.push(parsed);
          }
        }
      }
    } else if (kind === 'service') {
      // Services are handled separately for routing
    } else if (kind === 'configmap') {
      // ConfigMaps can be used for environment variables
    } else if (kind === 'secret') {
      // Secrets for sensitive data
    }
  }

  if (containers.length === 0) {
    throw new Error('No Pod or Deployment found in manifest');
  }

  // Kubernetes only requires container names to be unique within a Pod, so a
  // manifest with two Deployments can legitimately declare `web` twice. On one
  // bridge network that is one alias for two containers.
  assertDistinctAliases(appName, containers.map((c) => c.name));

  return containers;
}

/**
 * The image and declared ports of a manifest's first container, without
 * allocating anything.
 *
 * For the kubectl compatibility API, which has to echo back a Deployment that
 * looks like the one that was applied. It cannot read those from the
 * application row — a k8s application stores the whole Deployment body as its
 * manifest, so the single-container `{ image, ports }` shape the other
 * application types use is not there — and it must not read them from the
 * container row either, because that holds the allocated *host* port.
 *
 * Returns null when the manifest is not a Pod or Deployment.
 */
export function k8sPodTemplate(
  manifest: string | null | undefined,
): { image: string; ports: Array<{ containerPort: number; protocol: string }> } | null {
  if (!manifest?.trim()) return null;

  let docs: any[];
  try {
    docs = manifest.trim().startsWith('{')
      ? [JSON.parse(manifest)]
      : manifest.split('---').map((doc) => Bun.YAML.parse(doc) as any).filter(Boolean);
  } catch {
    return null;
  }

  for (const doc of docs) {
    const kind = doc?.kind?.toLowerCase();
    const podSpec = kind === 'pod' ? doc.spec : kind === 'deployment' ? doc.spec?.template?.spec : null;
    const container = podSpec?.containers?.[0];
    if (!container) continue;
    return {
      image: container.image ?? '',
      ports: (container.ports ?? [])
        .map((p: any) => ({
          containerPort: parseInt(p?.containerPort),
          protocol: String(p?.protocol ?? 'TCP').toUpperCase(),
        }))
        .filter((p: any) => Number.isInteger(p.containerPort)),
    };
  }
  return null;
}

function parseK8sContainer(
  container: K8sContainer,
  metadata: K8sMetadata,
  volumes: Record<string, K8sVolume>,
  appName: string,
  allocatePort: PortAllocator,
  restartPolicy?: string
): ParsedK8sContainer {
  const env: Record<string, string> = {};
  
  if (container.env) {
    for (const envEntry of container.env) {
      env[envEntry.name] = envEntry.value || '';
    }
  }

  const ports: Record<string, Array<{ hostPort: string }>> = {};

  if (container.ports) {
    for (const port of container.ports) {
      ports[`${port.containerPort}/tcp`] = [{ hostPort: String(allocatePort()) }];
    }
  }

  const mounts: MountIntent[] = [];

  if (container.volumeMounts) {
    for (const vm of container.volumeMounts) {
      const declared = volumes[vm.name];
      const mode = vm.readOnly ? 'ro' : 'rw';
      if (declared?.hostPath?.path) {
        mounts.push({ kind: 'bind', source: declared.hostPath.path, target: vm.mountPath, mode });
      }
      // Every other volume kind is still dropped here. Making them work — and
      // refusing the ones that cannot — is the next piece of this work.
    }
  }

  let memory: number | undefined;
  if (container.resources?.limits?.memory) {
    memory = parseMemory(container.resources.limits.memory);
  }

  let cpuShares: number | undefined;
  if (container.resources?.limits?.cpu) {
    cpuShares = parseCpu(container.resources.limits.cpu);
  }

  const aliases = networkAliases(appName, container.name);

  // Strip any traefik.* labels from user metadata to prevent route hijacking
  const containerLabels: Record<string, string> = Object.fromEntries(
    Object.entries(metadata.labels || {}).filter(
      ([k]) => !k.toLowerCase().startsWith('traefik.')
    )
  );
  containerLabels[ALIAS_LABEL] = aliases[0];

  return {
    name: container.name,
    image: container.image || `${container.name}:latest`,
    env,
    ports,
    mounts,
    aliases,
    restartPolicy: restartPolicy || 'always',
    labels: containerLabels,
    command: container.command,
    args: container.args,
    workingDir: container.workingDir,
    memory,
    cpuShares,
  };
}

function parseMemory(memStr: string): number {
  const match = memStr.match(/^(\d+)([eEiKmMgG]?)$/);
  if (!match) return 0;
  
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'b').toLowerCase();
  
  switch (unit) {
    case 'e':
      return value * 1024 * 1024 * 1024 * 1024;
    case 'p':
      return value * 1024 * 1024 * 1024 * 1024;
    case 't':
      return value * 1024 * 1024 * 1024;
    case 'g':
      return value * 1024 * 1024 * 1024;
    case 'm':
      return value * 1024 * 1024;
    case 'k':
      return value * 1024;
    default:
      return value;
  }
}

function parseCpu(cpuStr: string): number {
  if (cpuStr.endsWith('m')) {
    return parseInt(cpuStr, 10);
  }
  return Math.floor(parseFloat(cpuStr) * 1024);
}

export function validateK8sManifest(manifest: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  try {
    // Detect JSON vs YAML
    const isJson = manifest.trim().startsWith('{') || manifest.trim().startsWith('[{');

    let docs: any[];
    if (isJson) {
      try {
        docs = [JSON.parse(manifest)];
      } catch {
        docs = [];
      }
    } else {
      docs = manifest.split('---').map(doc => Bun.YAML.parse(doc) as any).filter(Boolean);
    }
    
    if (docs.length === 0) {
      errors.push('Empty manifest');
      return { valid: false, errors };
    }
    
    const supportedKinds = ['pod', 'deployment', 'service', 'configmap', 'secret', 'ingress'];
    
    for (const doc of docs) {
      if (!doc.kind) {
        errors.push('Missing kind in manifest');
        continue;
      }
      
      if (!supportedKinds.includes(doc.kind.toLowerCase())) {
        errors.push(`Unsupported kind: ${doc.kind}`);
      }
      
      if (!doc.apiVersion) {
        errors.push(`Missing apiVersion for kind: ${doc.kind}`);
      }
    }
  } catch (e: any) {
    errors.push(`Manifest parse error: ${e.message}`);
  }
  
  return { valid: errors.length === 0, errors };
}
