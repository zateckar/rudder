import {
  ManifestError,
  createRouteAssigner,
  identityLabels,
  plannedContainerName,
  type DeploymentPlan,
  type PlanContext,
  type PlannedContainer,
  type PlannedFile,
} from './deploy/plan';
import { DEFAULT_TMPFS_OPTS, type MountIntent } from './mounts';
import { ALIAS_LABEL, assertDistinctAliases, networkAliases } from './networks';
import type { PortAllocator } from './ports';
import { parseYamlDocuments } from './yaml-errors';

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

/** A reference to one key of a ConfigMap or Secret. */
export interface K8sKeyRef {
  name?: string;
  /** Secrets spell it `name` too, but a volume source spells it `secretName`. */
  key?: string;
  optional?: boolean;
}

export interface K8sEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: K8sKeyRef;
    secretKeyRef?: K8sKeyRef;
    fieldRef?: { fieldPath?: string };
    resourceFieldRef?: { resource?: string };
  };
}

export interface K8sEnvFromSource {
  prefix?: string;
  configMapRef?: { name?: string; optional?: boolean };
  secretRef?: { name?: string; optional?: boolean };
}

export interface K8sContainer {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number; protocol?: string; hostPort?: number }>;
  env?: K8sEnvVar[];
  envFrom?: K8sEnvFromSource[];
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>;
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
  command?: string[];
  args?: string[];
  workingDir?: string;
}

/** Selects and renames individual keys of a ConfigMap or Secret volume. */
export interface K8sKeyToPath {
  key: string;
  path: string;
  mode?: number;
}

export interface K8sVolume {
  name: string;
  emptyDir?: { medium?: string; sizeLimit?: string } | Record<string, never> | null;
  hostPath?: { path: string };
  configMap?: { name: string; items?: K8sKeyToPath[]; defaultMode?: number; optional?: boolean };
  secret?: { secretName: string; items?: K8sKeyToPath[]; defaultMode?: number; optional?: boolean };
  // Declared so they can be refused by name rather than dropped.
  persistentVolumeClaim?: { claimName?: string };
  nfs?: unknown;
  projected?: unknown;
  downwardAPI?: unknown;
  csi?: unknown;
  ephemeral?: unknown;
}

/**
 * ConfigMaps and Secrets declared in the same manifest.
 *
 * There is no cluster to look anything else up in. A reference to an object
 * that is not here is refused rather than mounted as nothing — an application
 * that comes up misconfigured is worse than one that does not come up.
 */
interface ManifestObjects {
  configMaps: Map<string, Record<string, string>>;
  secrets: Map<string, Record<string, string>>;
}

/** Read the ConfigMap and Secret documents out of a manifest. */
function collectManifestObjects(docs: any[]): ManifestObjects {
  const objects: ManifestObjects = { configMaps: new Map(), secrets: new Map() };

  for (const doc of docs) {
    const kind = doc?.kind?.toLowerCase();
    const name = doc?.metadata?.name;
    if (!name) continue;

    if (kind === 'configmap') {
      const data: Record<string, string> = { ...(doc.data ?? {}) };
      // binaryData is base64 by definition; data is not.
      for (const [key, value] of Object.entries(doc.binaryData ?? {})) {
        data[key] = decodeBase64(String(value), `ConfigMap "${name}" key "${key}"`);
      }
      objects.configMaps.set(name, data);
    } else if (kind === 'secret') {
      const data: Record<string, string> = { ...(doc.stringData ?? {}) };
      for (const [key, value] of Object.entries(doc.data ?? {})) {
        data[key] = decodeBase64(String(value), `Secret "${name}" key "${key}"`);
      }
      objects.secrets.set(name, data);
    }
  }

  return objects;
}

/**
 * Volume kinds that need a cluster behind them. Named in the refusal rather
 * than dropped, so an application does not start without its storage and leave
 * the user to work out which of their volumes went missing.
 */
const UNSUPPORTED_VOLUME_KINDS = [
  'persistentVolumeClaim',
  'nfs',
  'projected',
  'downwardAPI',
  'csi',
  'ephemeral',
] as const;

/**
 * The files a ConfigMap or Secret volume should produce.
 *
 * Without `items` that is every key at its own name; with `items` it is the
 * selected keys, renamed. A selected key that does not exist is refused —
 * Kubernetes skips it, but Kubernetes has a control plane to notice with.
 */
function selectKeys(
  data: Record<string, string>,
  items: K8sKeyToPath[] | undefined,
  where: string,
): Array<{ path: string; content: string; mode?: number }> {
  if (!items?.length) {
    return Object.entries(data).map(([path, content]) => ({ path, content }));
  }
  return items.map((item) => {
    const content = data[item.key];
    if (content === undefined) {
      throw new ManifestError(`${where} selects the key "${item.key}", which is not present.`);
    }
    const path = item.path || item.key;
    if (path.includes('/')) {
      throw new ManifestError(
        `${where} writes key "${item.key}" to "${path}". Rudder places each key as a file directly ` +
          `in the mount path and cannot create subdirectories under it.`,
      );
    }
    return { path, content, mode: item.mode };
  });
}

/**
 * Translate a Kubernetes quantity into a tmpfs `size=` value.
 *
 * They disagree on spelling: Kubernetes writes `16Mi` for a mebibyte count and
 * `16M` for a megabyte one, while tmpfs reads a bare `k`/`m`/`g` as binary and
 * rejects anything else outright — with "Invalid argument", naming neither the
 * option nor the mount.
 */
export function tmpfsSize(quantity: string | undefined, where: string): string | undefined {
  if (quantity === undefined || quantity === null) return undefined;
  const raw = String(quantity).trim();
  if (!raw) return undefined;

  const binary = raw.match(/^(\d+)(Ki|Mi|Gi)$/);
  if (binary) return `${binary[1]}${{ Ki: 'k', Mi: 'm', Gi: 'g' }[binary[2] as 'Ki' | 'Mi' | 'Gi']}`;

  const decimal = raw.match(/^(\d+)([kKMGT])$/);
  if (decimal) {
    const factor = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[decimal[2] as 'k'];
    return String(Math.floor(parseInt(decimal[1], 10) * factor));
  }

  if (/^\d+$/.test(raw)) return raw;

  throw new ManifestError(
    `${where} has a sizeLimit of "${raw}", which is not a quantity Rudder can turn into a ` +
      `tmpfs size. Use a form like 64Mi, 1Gi, or a plain byte count.`,
  );
}

function decodeBase64(value: string, what: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    throw new ManifestError(`${what} is not valid base64.`);
  }
}

/**
 * The entries of a ConfigMap or Secret a volume or `envFrom` should use.
 *
 * Returns null when the object is absent and the reference is marked optional,
 * which is Kubernetes' own way of saying "carry on without it".
 */
function lookupObject(
  objects: ManifestObjects,
  kind: 'configMap' | 'secret',
  name: string | undefined,
  optional: boolean | undefined,
  usedBy: string,
): Record<string, string> | null {
  const label = kind === 'configMap' ? 'ConfigMap' : 'Secret';
  if (!name) {
    throw new ManifestError(`${usedBy} references a ${label} with no name.`);
  }
  const found = (kind === 'configMap' ? objects.configMaps : objects.secrets).get(name);
  if (found) return found;
  if (optional) return null;
  throw new ManifestError(
    `${usedBy} references the ${label} "${name}", which is not declared in this manifest. ` +
      `Rudder has no cluster to look it up in — add it as another document in the manifest, ` +
      `use a Rudder secret, or mark the reference optional.`,
  );
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
    try {
      docs = parseYamlDocuments(manifest) as any[];
    } catch (e: any) {
      // A refusal that says where, rather than the parser's exception escaping
      // to the caller as a 500.
      throw new ManifestError(e.message);
    }
  }

  const containers: PlannedContainer[] = [];
  const notes: string[] = [];
  /** Volumes declared by the Pod spec, by name, as written. */
  const volumes: Record<string, K8sVolume> = {};

  // ConfigMaps and Secrets are read first: a manifest may declare them after
  // the Pod that mounts them, and a document order dependency would be a
  // surprise nobody could debug from the error message.
  const objects = collectManifestObjects(docs);

  /** Which containers mount each volume, so a shared `emptyDir` can be refused. */
  const mountedBy = new Map<string, string[]>();

  interface PendingContainer {
    container: K8sContainer;
    metadata: K8sMetadata;
    restartPolicy?: string;
  }
  const pending: PendingContainer[] = [];

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
        pending.push({ container, metadata, restartPolicy: podSpec.restartPolicy });
        for (const vm of container.volumeMounts ?? []) {
          mountedBy.set(vm.name, [...(mountedBy.get(vm.name) ?? []), container.name]);
        }
      }
    } else if (kind === 'service') {
      // Services are handled separately for routing
    } else if (kind === 'configmap' || kind === 'secret') {
      // Read above, into `objects`.
    }
  }

  if (pending.length === 0) {
    throw new ManifestError('No Pod or Deployment found in manifest');
  }

  for (const { container, metadata, restartPolicy } of pending) {
    containers.push(
      parseK8sContainer(container, metadata, {
        volumes,
        objects,
        mountedBy,
        ctx,
        allocatePort,
        restartPolicy,
        notes,
      }),
    );
  }

  // Kubernetes only requires container names to be unique within a Pod, so a
  // manifest with two Deployments can legitimately declare `web` twice. On one
  // bridge network that is one alias for two containers.
  assertDistinctAliases(appName, containers.map((c) => c.key));

  // The deviation that cannot be detected statically: whether a container talks
  // to a sibling over `localhost` is in the application's own configuration,
  // not in the manifest. So it is stated whenever the shape occurs — a
  // multi-container manifest — rather than when it bites.
  if (containers.length > 1) {
    notes.push(
      `This manifest has ${containers.length} containers. In a Kubernetes Pod they would share ` +
        `one network namespace and reach each other on localhost; here each gets its own address ` +
        `on a bridge network, so they must use each other's names instead — ` +
        `${containers.map((c) => `"${c.key}"`).join(', ')}. Anything configured to connect to ` +
        `127.0.0.1 or localhost will reach only itself.`,
    );
  }

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

interface ParseContainerInput {
  volumes: Record<string, K8sVolume>;
  objects: ManifestObjects;
  mountedBy: Map<string, string[]>;
  ctx: PlanContext;
  allocatePort: PortAllocator;
  restartPolicy?: string;
  notes: string[];
}

function parseK8sContainer(
  container: K8sContainer,
  metadata: K8sMetadata,
  input: ParseContainerInput,
): PlannedContainer {
  const { volumes, objects, mountedBy, ctx, allocatePort, restartPolicy, notes } = input;
  const where = `Container "${container.name}"`;

  const env: Record<string, string> = {};

  // envFrom first, so an explicit `env` entry of the same name wins — which is
  // what Kubernetes does. Both were ignored entirely before.
  for (const source of container.envFrom ?? []) {
    const prefix = source.prefix ?? '';
    if (source.configMapRef) {
      const data = lookupObject(objects, 'configMap', source.configMapRef.name, source.configMapRef.optional, `${where} envFrom`);
      for (const [key, value] of Object.entries(data ?? {})) env[`${prefix}${key}`] = value;
    }
    if (source.secretRef) {
      const data = lookupObject(objects, 'secret', source.secretRef.name, source.secretRef.optional, `${where} envFrom`);
      for (const [key, value] of Object.entries(data ?? {})) env[`${prefix}${key}`] = value;
    }
  }

  for (const entry of container.env ?? []) {
    const from = entry.valueFrom;
    if (!from) {
      env[entry.name] = entry.value ?? '';
      continue;
    }
    if (from.configMapKeyRef || from.secretKeyRef) {
      const kind = from.configMapKeyRef ? 'configMap' : 'secret';
      const ref = (from.configMapKeyRef ?? from.secretKeyRef)!;
      const data = lookupObject(objects, kind, ref.name, ref.optional, `${where} env "${entry.name}"`);
      if (data === null) continue;
      const value = ref.key ? data[ref.key] : undefined;
      if (value === undefined) {
        if (ref.optional) continue;
        throw new ManifestError(
          `${where} reads env "${entry.name}" from key "${ref.key}" of ` +
            `${kind === 'configMap' ? 'ConfigMap' : 'Secret'} "${ref.name}", which has no such key.`,
        );
      }
      env[entry.name] = value;
      continue;
    }
    // fieldRef and resourceFieldRef describe a Pod that does not exist here.
    // They were silently dropped, so the container started with the variable
    // unset and whatever that meant to the application.
    const unsupported = from.fieldRef ? `fieldRef (${from.fieldRef.fieldPath})` : 'resourceFieldRef';
    throw new ManifestError(
      `${where} reads env "${entry.name}" from ${unsupported}, which Rudder cannot resolve — ` +
        `there is no Kubernetes API to ask. Set the value directly.`,
    );
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
      if (port.hostPort !== undefined) {
        notes.push(
          `${where} asks to publish container port ${port.containerPort} on host port ` +
            `${port.hostPort}. Rudder allocates host ports itself so two applications can both ` +
            `listen on the same port, and Traefik routes to whichever it was given.`,
        );
      }
      ports[`${port.containerPort}/tcp`] = [{ hostPort: String(allocatePort()) }];
    }
  }

  const mounts: MountIntent[] = [];
  const files: PlannedFile[] = [];

  for (const vm of container.volumeMounts ?? []) {
    const declared = volumes[vm.name];
    const mode = vm.readOnly ? 'ro' : 'rw';
    const at = `${where} mounts "${vm.name}" at ${vm.mountPath}`;

    if (!declared) {
      throw new ManifestError(`${at}, but no volume of that name is declared in the Pod spec.`);
    }

    if (vm.subPath) {
      throw new ManifestError(
        `${at} with subPath "${vm.subPath}", which Rudder does not support. ` +
          `Mount the whole volume, or split it into separate volumes.`,
      );
    }

    if (declared.hostPath?.path) {
      // Subject to the host mount allow-list, which the executor applies.
      mounts.push({ kind: 'bind', source: declared.hostPath.path, target: vm.mountPath, mode });
      continue;
    }

    if (declared.emptyDir !== undefined && declared.emptyDir !== null) {
      // An emptyDir is shared between the containers of a Pod. Rudder's
      // containers do not share a namespace, so two of them mounting one
      // emptyDir would silently get two separate scratch directories.
      const sharers = mountedBy.get(vm.name) ?? [];
      if (sharers.length > 1) {
        throw new ManifestError(
          `The emptyDir volume "${vm.name}" is mounted by ${sharers.map((s) => `"${s}"`).join(' and ')}. ` +
            `Sharing one needs a shared namespace, and Rudder runs each container separately on a ` +
            `bridge network. Give each container its own emptyDir, or have one serve the data to ` +
            `the other over the network.`,
        );
      }
      const size = tmpfsSize((declared.emptyDir as { sizeLimit?: string }).sizeLimit, at);
      const medium = (declared.emptyDir as { medium?: string }).medium;
      if (medium && medium.toLowerCase() !== 'memory') {
        notes.push(
          `emptyDir "${vm.name}" asked for medium "${medium}"; Rudder backs every emptyDir with ` +
            `memory, so its contents count against the container's memory limit.`,
        );
      }
      mounts.push({
        kind: 'tmpfs',
        target: vm.mountPath,
        options: size ? `${DEFAULT_TMPFS_OPTS},size=${size}` : DEFAULT_TMPFS_OPTS,
      });
      continue;
    }

    if (declared.configMap || declared.secret) {
      const isSecret = !!declared.secret;
      const source = declared.secret ?? declared.configMap!;
      const name = declared.secret ? declared.secret.secretName : declared.configMap!.name;
      const data = lookupObject(objects, isSecret ? 'secret' : 'configMap', name, source.optional, at);
      // Optional and absent: Kubernetes mounts an empty directory, and so do we.
      const entries = selectKeys(data ?? {}, source.items, at);

      // A tmpfs so the mount point exists and is writable for the upload, and
      // so the content never touches the worker's disk. The files go in before
      // the container starts, which is what makes them present at entrypoint.
      mounts.push({ kind: 'tmpfs', target: vm.mountPath, options: DEFAULT_TMPFS_OPTS });
      for (const entry of entries) {
        files.push({
          dir: vm.mountPath,
          name: entry.path,
          content: entry.content,
          mode: entry.mode ?? source.defaultMode ?? (isSecret ? 0o400 : 0o644),
        });
      }
      continue;
    }

    const kind = UNSUPPORTED_VOLUME_KINDS.find((k) => k in declared);
    throw new ManifestError(
      kind
        ? `${at}, which is a ${kind} volume. Rudder has no storage layer behind that — ` +
          `use a hostPath under an allowed prefix, an emptyDir, or a ConfigMap or Secret ` +
          `declared in this manifest.`
        : `${at}, but that volume declares no source Rudder recognises.`,
    );
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
    files: files.length > 0 ? files : undefined,
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
      docs = parseYamlDocuments(manifest) as any[];
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
    // Already located and worded by parseYamlDocuments; prefixing it again is
    // what produced "YAML parse error: YAML Parse error: …".
    errors.push(e.message);
  }

  return { valid: errors.length === 0, errors };
}
