import {
  ManifestError,
  createRouteAssigner,
  identityLabels,
  plannedContainerName,
  type DeploymentPlan,
  type PlanContext,
  type PlannedContainer,
} from './deploy/plan';
import type { MountIntent } from './mounts';
import { ALIAS_LABEL, assertDistinctAliases, networkAliases } from './networks';
import type { PortAllocator } from './ports';

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

export function parseK8sManifest(manifest: string, ctx: PlanContext): DeploymentPlan {
  const { appName, baseDomain, allocatePort } = ctx;
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

  const containers: PlannedContainer[] = [];
  const notes: string[] = [];
  /** Volumes declared by the Pod spec, by name, as written. */
  const volumes: Record<string, K8sVolume> = {};

  for (const doc of docs) {
    if (!doc) continue;

    const kind = doc.kind?.toLowerCase();
    const metadata = doc.metadata || {};
    const spec = doc.spec || {};

    if (kind === 'pod' || kind === 'deployment') {
      const podSpec = (kind === 'pod' ? spec : spec.template?.spec) as K8sPodSpec | undefined;
      if (!podSpec) continue;

      if (podSpec.volumes) {
        for (const vol of podSpec.volumes) volumes[vol.name] = vol;
      }

      for (const container of podSpec.containers ?? []) {
        containers.push(
          parseK8sContainer(container, metadata, volumes, ctx, allocatePort, podSpec.restartPolicy),
        );
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
    throw new ManifestError('No Pod or Deployment found in manifest');
  }

  // Kubernetes only requires container names to be unique within a Pod, so a
  // manifest with two Deployments can legitimately declare `web` twice. On one
  // bridge network that is one alias for two containers.
  assertDistinctAliases(appName, containers.map((c) => c.key));

  // Routes are assigned after the whole manifest is read, so the container that
  // owns the application hostname is the first one declared that publishes a
  // port, whichever document it came from.
  if (baseDomain || ctx.appDomain) {
    const assignRoute = createRouteAssigner(ctx);
    for (const container of containers) {
      const firstPortKey = Object.keys(container.ports)[0];
      if (!firstPortKey) continue;
      // The binding's value, not its key: the key is the port inside the
      // container and the value is the host port Traefik has to reach.
      container.route = assignRoute(container.key, parseInt(container.ports[firstPortKey][0].hostPort));
    }
  }

  return { containers, notes };
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
  ctx: PlanContext,
  allocatePort: PortAllocator,
  restartPolicy?: string
): PlannedContainer {
  const env: Record<string, string> = {};

  if (container.env) {
    for (const envEntry of container.env) {
      env[envEntry.name] = envEntry.value || '';
    }
  }

  /**
   * Podman port bindings, keyed `<containerPort>/<protocol>`.
   *
   * The host port is allocated, never taken from the manifest. A Pod spec's
   * `containerPort` describes the port *inside* the container — Kubernetes has
   * no concept of publishing it on the identical host port, and doing so meant
   * two applications that both listened on 80 could not share a worker, and one
   * application could not run two generations at once.
   */
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

  const aliases = networkAliases(ctx.appName, container.name);

  // Strip any traefik.* labels from user metadata to prevent route hijacking
  const safeMetaLabels = Object.fromEntries(
    Object.entries(metadata.labels || {}).filter(
      ([k]) => !k.toLowerCase().startsWith('traefik.')
    )
  );

  return {
    key: container.name,
    name: plannedContainerName(ctx, container.name),
    image: container.image || `${container.name}:latest`,
    env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ports,
    mounts,
    aliases,
    restartPolicy: podmanRestartPolicy(restartPolicy, ctx.restartPolicy),
    labels: {
      ...safeMetaLabels,
      ...identityLabels(ctx),
      [ALIAS_LABEL]: aliases[0],
      'app.kubernetes.io/name': container.name,
      'app.kubernetes.io/version': container.image?.split(':')[1] || 'latest',
    },
    // Kubernetes `command` is the entrypoint and `args` is the command — the
    // same split OCI makes, named the other way round. Mapping k8s `command`
    // onto Podman's Cmd left an image's own ENTRYPOINT in front of it, and
    // dropped `args` entirely.
    entrypoint: container.command,
    command: container.args,
    workingDir: container.workingDir,
    memory,
    cpuQuota: cpuShares ? cpuShares * 100 : undefined,
    cpuPeriod: cpuShares ? 100000 : undefined,
  };
}

/**
 * Translate a Pod's `restartPolicy` into the spelling Podman accepts.
 *
 * Kubernetes writes `Always`, `OnFailure`, `Never`; Podman wants `always`,
 * `on-failure`, `no`, and rejects anything else outright — so a manifest that
 * declared a restart policy at all failed to create its containers, with a
 * message about an invalid argument that named nothing the user had written.
 */
export function podmanRestartPolicy(
  declared: string | undefined,
  fallback: string | null | undefined,
): string {
  switch (declared?.toLowerCase()) {
    case 'always': return 'always';
    case 'onfailure': case 'on-failure': return 'on-failure';
    case 'never': case 'no': return 'no';
    default: return fallback || 'always';
  }
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
