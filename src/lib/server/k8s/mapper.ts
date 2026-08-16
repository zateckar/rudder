/**
 * Kubernetes ↔ Rudder resource mapping.
 *
 *   Team        → Namespace
 *   Application → Deployment
 *   Container   → Pod
 */
import { k8sPodTemplate } from '../kubernetes';

// ── Path matching utility ──────────────────────────────────────

/**
 * Match a URL path against a pattern with `:param` placeholders.
 * Returns extracted params or null on mismatch.
 */
export function matchPath(
  path: string,
  pattern: string,
): Record<string, string> | null {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Team → Namespace ───────────────────────────────────────────

export function teamToNamespace(team: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: team.slug,
      uid: team.id,
      creationTimestamp: team.createdAt.toISOString(),
      resourceVersion: String(team.updatedAt.getTime()),
      labels: {
        'kubernetes.io/metadata.name': team.slug,
        'rudder.dev/team-name': team.name,
      },
    },
    spec: { finalizers: ['kubernetes'] },
    status: { phase: 'Active' },
  };
}

// ── Application → Deployment ───────────────────────────────────

/**
 * A manifest that is itself an image reference, or the empty string.
 *
 * The oldest single-container applications stored their manifest as a bare
 * `repo/name:tag`. Everything else that fails to parse as JSON is a document,
 * and a document must never be presented as an image name — see the call site.
 */
export function imageReferenceOrBlank(manifest: string | null | undefined): string {
  const trimmed = (manifest ?? '').trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 255) return '';
  // repo[:tag] / repo@sha256:… — no path traversal, no scheme, one line.
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/.test(trimmed)
    ? trimmed
    : '';
}

export function applicationToDeployment(
  app: {
    id: string;
    name: string;
    type: string;
    manifest: string | null;
    environment: string | null;
    replicas: number;
    restartPolicy: string;
    workerId: string | null;
    domain: string | null;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  teamSlug: string,
  appContainers: Array<{ id: string; status: string }>,
  /**
   * Message from a deploy that just failed, if any.  Surfaced as a failing
   * Progressing condition so `kubectl` reports the rollout accurately instead
   * of always claiming success.
   */
  deployError?: string | null,
) {
  let image = '';
  let ports: Array<{ containerPort: number; protocol: string }> = [];

  // A k8s application's manifest is the whole Deployment or Pod body, not the
  // `{ image, ports }` object the other types store, so it has to be read as
  // one. Falling through to the generic branch reported an empty image and a
  // hardcoded port 80 for every kubectl-applied deployment.
  const podTemplate = app.type === 'k8s' ? k8sPodTemplate(app.manifest) : null;
  if (podTemplate) {
    image = podTemplate.image;
    ports = podTemplate.ports;
  } else {
    try {
      const cfg = JSON.parse(app.manifest || '{}');
      image = cfg.image || '';
      if (cfg.ports) {
        ports = cfg.ports.map((p: any) => ({
          containerPort: parseInt(p.containerPort),
          protocol: (p.protocol || 'TCP').toUpperCase(),
        }));
      }
    } catch {
      // A manifest that is not JSON is either a legacy single-container app
      // whose manifest is a bare image reference, or a compose file. Only the
      // first is an image. Echoing the second put the whole compose document —
      // environment blocks, API keys and all — into `kubectl get deploy -o yaml`
      // for anyone with a key for that team.
      image = imageReferenceOrBlank(app.manifest);
    }
  }

  let envVars: Array<{ name: string; value: string }> = [];
  if (app.environment) {
    try {
      const arr = JSON.parse(app.environment);
      envVars = arr.map((e: any) => ({ name: e.key, value: e.value || '' }));
    } catch {
      /* ignore */
    }
  }

  const running = appContainers.filter((c) => c.status === 'running').length;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: app.name,
      namespace: teamSlug,
      uid: app.id,
      creationTimestamp: app.createdAt.toISOString(),
      resourceVersion: String(app.updatedAt.getTime()),
      generation: 1,
      labels: { app: app.name },
      annotations: {
        'rudder.dev/type': app.type,
        ...(app.workerId ? { 'rudder.dev/worker-id': app.workerId } : {}),
        ...(app.domain ? { 'rudder.dev/domain': app.domain } : {}),
        ...(app.description ? { 'rudder.dev/description': app.description } : {}),
      },
    },
    spec: {
      replicas: app.replicas,
      selector: { matchLabels: { app: app.name } },
      template: {
        metadata: { labels: { app: app.name } },
        spec: {
          containers: [
            {
              name: app.name,
              image,
              ...(envVars.length > 0 ? { env: envVars } : {}),
              ports:
                ports.length > 0
                  ? ports
                  : [{ containerPort: 80, protocol: 'TCP' }],
            },
          ],
          restartPolicy:
            app.restartPolicy === 'no'
              ? 'Never'
              : app.restartPolicy === 'on-failure'
                ? 'OnFailure'
                : 'Always',
        },
      },
    },
    status: {
      replicas: appContainers.length,
      readyReplicas: running,
      availableReplicas: running,
      updatedReplicas: appContainers.length,
      observedGeneration: 1,
      conditions: [
        {
          type: 'Available',
          status: running > 0 ? 'True' : 'False',
          lastUpdateTime: app.updatedAt.toISOString(),
          lastTransitionTime: app.updatedAt.toISOString(),
          reason:
            running > 0
              ? 'MinimumReplicasAvailable'
              : 'MinimumReplicasUnavailable',
          message:
            running > 0
              ? 'Deployment has minimum availability.'
              : 'Deployment does not have minimum availability.',
        },
        {
          type: 'Progressing',
          status: deployError ? 'False' : 'True',
          lastUpdateTime: app.updatedAt.toISOString(),
          lastTransitionTime: app.createdAt.toISOString(),
          reason: deployError ? 'ProgressDeadlineExceeded' : 'NewReplicaSetAvailable',
          message: deployError
            ? `ReplicaSet "${app.name}" failed to progress: ${deployError}`
            : `ReplicaSet "${app.name}" has successfully progressed.`,
        },
      ],
    },
  };
}

// ── Container → Pod ────────────────────────────────────────────

/**
 * The pod name for a container row.
 *
 * Containers discovered from a worker keep Podman's leading slash
 * (`/whoami`), while containers Rudder created do not. A slash is not legal in
 * a Kubernetes object name and makes the pod unaddressable — `kubectl logs
 * /whoami` sends a path segment the server cannot route — so it is stripped
 * here, and every lookup compares through this function.
 */
export function podNameOf(containerName: string): string {
  return containerName.replace(/^\/+/, '');
}

/**
 * The port inside the container, recovered from the stored Podman bindings.
 *
 * `exposed_port` is the *host* port Traefik connects to; Kubernetes'
 * `containerPort` is the port the process listens on inside the container.
 * Those were the same number for k8s applications while a manifest's
 * `containerPort` was published verbatim. Now that host ports are allocated
 * they are not, and reporting the host port here would have
 * `kubectl get pod -o yaml` describe a port nothing in the container listens on.
 *
 * Falls back to the host port for rows written before bindings were recorded —
 * which is exactly what those rows used to report.
 */
export function containerPortOf(
  ports: string | null | undefined,
  exposedPort: number | null,
): number | null {
  if (!ports) return exposedPort;

  let parsed: Record<string, Array<{ hostPort?: string; HostPort?: string }> | null>;
  try {
    parsed = JSON.parse(ports);
  } catch {
    return exposedPort;
  }
  if (!parsed || typeof parsed !== 'object') return exposedPort;

  const entries = Object.entries(parsed)
    .map(([key, bindings]) => ({
      containerPort: parseInt(String(key).split('/')[0]),
      hostPorts: (bindings ?? []).map((b) => parseInt(String(b?.hostPort ?? b?.HostPort))),
    }))
    .filter((e) => Number.isInteger(e.containerPort));

  if (entries.length === 0) return exposedPort;

  // A container can publish several ports and only one of them is the one
  // Traefik routes to, so match on the host port before falling back to order.
  const routed = entries.find((e) => exposedPort !== null && e.hostPorts.includes(exposedPort));
  return (routed ?? entries[0]).containerPort;
}

/** The container rows this module maps into Pods. */
export interface PodContainerRow {
  id: string;
  name: string;
  containerId: string;
  image: string;
  status: string;
  ports?: string | null;
  exposedPort: number | null;
  labels?: string | null;
  generation?: number | null;
  workerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The name a container answers to inside its Pod — the compose service name,
 * the Kubernetes container name, or the application's own name.
 *
 * Read from the `rudder.alias` label the deploy path stamps, which is exactly
 * that key. Falls back to the whole container name for rows written before the
 * label existed, and for containers discovered on a worker rather than deployed.
 */
export function containerKeyOf(row: { name: string; labels?: string | null }): string {
  if (row.labels) {
    try {
      const alias = JSON.parse(row.labels)?.['rudder.alias'];
      if (typeof alias === 'string' && alias) return alias;
    } catch {
      // Unparseable labels: fall through to the name.
    }
  }
  return podNameOf(row.name);
}

/** One Pod's worth of containers, and the name kubectl addresses it by. */
export interface PodGroup {
  name: string;
  rows: PodContainerRow[];
}

/**
 * Group an application's containers the way Kubernetes would see them.
 *
 * A Kubernetes application was applied as one Pod, so it is reported as one
 * Pod — with its containers listed, which is what `kubectl apply` was given.
 * Reporting a three-container manifest as three Pods described something the
 * user never wrote.
 *
 * A generation retained for a fast rollback is a separate Pod, because it is a
 * separate set of running processes and collapsing it into the live one would
 * show containers that are stopped as part of the Pod serving traffic.
 *
 * Compose and single-container applications keep one Pod per container.
 * Compose services are separate workloads that happen to share a file, and a
 * replica genuinely is a separate Pod — merging either would be the same kind
 * of lie in the other direction.
 */
export function podGroupsFor(
  app: { name: string; type?: string | null },
  rows: PodContainerRow[],
): PodGroup[] {
  if (app.type !== 'k8s') {
    return rows.map((row) => ({ name: podNameOf(row.name), rows: [row] }));
  }

  const byGeneration = new Map<number, PodContainerRow[]>();
  for (const row of rows) {
    const generation = row.generation ?? 1;
    byGeneration.set(generation, [...(byGeneration.get(generation) ?? []), row]);
  }

  const base = podNameOf(app.name);
  const single = byGeneration.size === 1;
  return [...byGeneration.entries()]
    .sort(([a], [b]) => a - b)
    .map(([generation, groupRows]) => ({
      name: single ? base : `${base}-g${generation}`,
      rows: groupRows,
    }));
}

/** The Kubernetes phase a container's status corresponds to. */
function phaseOf(status: string): 'Running' | 'Succeeded' | 'Pending' | 'Unknown' {
  // `stopped` is what a generation retained for a fast rollback looks like, and
  // it is finished in the same sense `exited` is — reporting it as Unknown
  // would make `kubectl get pods` look broken during a retention window.
  if (status === 'running') return 'Running';
  if (status === 'exited' || status === 'stopped') return 'Succeeded';
  if (status === 'created') return 'Pending';
  return 'Unknown';
}

/**
 * The Pod's phase, from its containers'.
 *
 * Kubernetes' own rule, near enough: Pending while anything is still starting,
 * Running once anything is up, Succeeded when everything has finished.
 */
function podPhase(phases: string[]): string {
  if (phases.length === 0) return 'Unknown';
  if (phases.includes('Pending')) return 'Pending';
  if (phases.includes('Running')) return 'Running';
  if (phases.every((p) => p === 'Succeeded')) return 'Succeeded';
  return 'Unknown';
}

export function podGroupToPod(group: PodGroup, appName: string, teamSlug: string) {
  // The oldest container in the group stands for the Pod: a Pod is created
  // once, and its containers are created in a loop within that one deploy.
  const oldest = group.rows.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  const newest = group.rows.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
  const phases = group.rows.map((r) => phaseOf(r.status));
  const phase = podPhase(phases);
  const ready = phase === 'Running' && phases.every((p) => p === 'Running');

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: group.name,
      namespace: teamSlug,
      uid: oldest.id,
      creationTimestamp: oldest.createdAt.toISOString(),
      resourceVersion: String(newest.updatedAt.getTime()),
      labels: {
        app: appName,
        'pod-template-hash': oldest.id.slice(0, 10),
      },
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          name: `${appName}-${oldest.id.slice(0, 10)}`,
          uid: oldest.id,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      containers: group.rows.map((row) => {
        const containerPort = containerPortOf(row.ports, row.exposedPort);
        return {
          name: containerKeyOf(row),
          image: row.image,
          ...(containerPort ? { ports: [{ containerPort, protocol: 'TCP' }] } : {}),
        };
      }),
      ...(oldest.workerId ? { nodeName: oldest.workerId } : {}),
      restartPolicy: 'Always',
    },
    status: {
      phase,
      conditions: [
        {
          type: 'Initialized',
          status: 'True',
          lastTransitionTime: oldest.createdAt.toISOString(),
        },
        {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          lastTransitionTime: newest.updatedAt.toISOString(),
        },
        {
          type: 'ContainersReady',
          status: ready ? 'True' : 'False',
          lastTransitionTime: newest.updatedAt.toISOString(),
        },
        {
          type: 'PodScheduled',
          status: 'True',
          lastTransitionTime: oldest.createdAt.toISOString(),
        },
      ],
      containerStatuses: group.rows.map((row) => {
        const rowPhase = phaseOf(row.status);
        return {
          name: containerKeyOf(row),
          image: row.image,
          imageID: `podman://${row.image}`,
          containerID: `podman://${row.containerId}`,
          ready: rowPhase === 'Running',
          restartCount: 0,
          started: rowPhase === 'Running',
          state:
            rowPhase === 'Running'
              ? { running: { startedAt: row.updatedAt.toISOString() } }
              : rowPhase === 'Succeeded'
                ? {
                    terminated: {
                      exitCode: 0,
                      finishedAt: row.updatedAt.toISOString(),
                      reason: 'Completed',
                    },
                  }
                : { waiting: { reason: 'ContainerCreating' } },
        };
      }),
      hostIP: '0.0.0.0',
      podIP: '0.0.0.0',
      startTime: oldest.createdAt.toISOString(),
    },
  };
}

/** One container as its own Pod — what compose services and replicas are. */
export function containerToPod(container: PodContainerRow, appName: string, teamSlug: string) {
  return podGroupToPod({ name: podNameOf(container.name), rows: [container] }, appName, teamSlug);
}

// ── K8s Deployment body → Rudder Application fields ────────────

export function parseDeploymentBody(body: any): {
  name: string;
  image: string;
  environment: string | null;
  replicas: number;
  manifest: string;
  restartPolicy: string;
  type: string;
  workerAnnotation?: string;
  domain?: string;
  description?: string;
} {
  const name = body.metadata?.name;
  if (!name) throw new Error('metadata.name is required');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      'metadata.name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens',
    );
  }

  const spec = body.spec;
  if (!spec) throw new Error('spec is required');

  const template = spec.template?.spec;
  if (!template?.containers?.[0]?.image)
    throw new Error('spec.template.spec.containers[0].image is required');

  // Store the full Deployment/Pod body as JSON so parseK8sManifest
  // can process multi-container setups, volumes, env vars, etc.
  const manifest = JSON.stringify(body);

  const restartPolicy =
    template?.restartPolicy === 'Never'
      ? 'no'
      : template?.restartPolicy === 'OnFailure'
        ? 'on-failure'
        : 'always';

  return {
    name,
    image: template.containers[0].image,
    environment: null, // Env vars are extracted from the full manifest by parseK8sManifest
    replicas: spec.replicas ?? 1,
    manifest,
    restartPolicy,
    type: 'k8s',          // Treat kubectl-applied deployments as k8s type
    workerAnnotation: body.metadata?.annotations?.['rudder.dev/worker'],
    domain: body.metadata?.annotations?.['rudder.dev/domain'],
    description:
      body.metadata?.annotations?.['rudder.dev/description'] ||
      body.metadata?.annotations?.['description'],
  };
}

// ── List wrapper ───────────────────────────────────────────────

export function k8sList(kind: string, apiVersion: string, items: any[]) {
  return {
    apiVersion,
    kind,
    metadata: {
      resourceVersion: String(Date.now()),
    },
    items,
  };
}

// ── Scale sub-resource ─────────────────────────────────────────

export function deploymentToScale(
  app: { id: string; name: string; replicas: number; updatedAt: Date },
  teamSlug: string,
  currentReplicas: number,
) {
  return {
    apiVersion: 'autoscaling/v1',
    kind: 'Scale',
    metadata: {
      name: app.name,
      namespace: teamSlug,
      uid: app.id,
      resourceVersion: String(app.updatedAt.getTime()),
    },
    spec: { replicas: app.replicas },
    status: { replicas: currentReplicas },
  };
}

