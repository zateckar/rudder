/**
 * Kubernetes ↔ Rudder resource mapping.
 *
 *   Team        → Namespace
 *   Application → Deployment
 *   Container   → Pod
 */

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
    image = app.manifest || '';
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

export function containerToPod(
  container: {
    id: string;
    name: string;
    containerId: string;
    image: string;
    status: string;
    exposedPort: number | null;
    workerId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  appName: string,
  teamSlug: string,
) {
  const phase =
    container.status === 'running'
      ? 'Running'
      : container.status === 'exited'
        ? 'Succeeded'
        : container.status === 'created'
          ? 'Pending'
          : 'Unknown';

  const containerState =
    phase === 'Running'
      ? { running: { startedAt: container.updatedAt.toISOString() } }
      : phase === 'Succeeded'
        ? {
            terminated: {
              exitCode: 0,
              finishedAt: container.updatedAt.toISOString(),
              reason: 'Completed',
            },
          }
        : { waiting: { reason: 'ContainerCreating' } };

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podNameOf(container.name),
      namespace: teamSlug,
      uid: container.id,
      creationTimestamp: container.createdAt.toISOString(),
      resourceVersion: String(container.updatedAt.getTime()),
      labels: {
        app: appName,
        'pod-template-hash': container.id.slice(0, 10),
      },
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          name: `${appName}-${container.id.slice(0, 10)}`,
          uid: container.id,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      containers: [
        {
          name: podNameOf(container.name),
          image: container.image,
          ...(container.exposedPort
            ? {
                ports: [
                  {
                    containerPort: container.exposedPort,
                    protocol: 'TCP',
                  },
                ],
              }
            : {}),
        },
      ],
      ...(container.workerId ? { nodeName: container.workerId } : {}),
      restartPolicy: 'Always',
    },
    status: {
      phase,
      conditions: [
        {
          type: 'Initialized',
          status: 'True',
          lastTransitionTime: container.createdAt.toISOString(),
        },
        {
          type: 'Ready',
          status: phase === 'Running' ? 'True' : 'False',
          lastTransitionTime: container.updatedAt.toISOString(),
        },
        {
          type: 'ContainersReady',
          status: phase === 'Running' ? 'True' : 'False',
          lastTransitionTime: container.updatedAt.toISOString(),
        },
        {
          type: 'PodScheduled',
          status: 'True',
          lastTransitionTime: container.createdAt.toISOString(),
        },
      ],
      containerStatuses: [
        {
          name: podNameOf(container.name),
          image: container.image,
          imageID: `podman://${container.image}`,
          containerID: `podman://${container.containerId}`,
          ready: phase === 'Running',
          restartCount: 0,
          started: phase === 'Running',
          state: containerState,
        },
      ],
      hostIP: '0.0.0.0',
      podIP: '0.0.0.0',
      startTime: container.createdAt.toISOString(),
    },
  };
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

