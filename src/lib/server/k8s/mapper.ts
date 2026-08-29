/**
 * Kubernetes ↔ Rudder resource mapping.
 *
 *   Team        → Namespace
 *   Application → Deployment
 *   Container   → Pod
 */
import {
  MAX_ROUTES_PER_CONTAINER,
  parseExposedPorts,
  parsePortList,
} from '../deploy/plan';
import { parseAppsecRules, parseRuleList, type AppsecRuleId } from '../appsec';
import { firstRuleRefusal } from '$lib/appsec-rules';
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

/**
 * Ceiling on `?tailLines=` for pod logs.
 *
 * The non-follow log path buffers the whole response in memory before it
 * answers, so an unclamped count is a request for as much of the control plane's
 * heap as the caller cares to name — `kubectl logs --tail=100000000` needs no
 * privilege beyond a working API key. kubectl's own default when `--tail` is
 * omitted is 10; this is the highest number worth honouring, not a target.
 */
export const MAX_TAIL_LINES = 5000;

/** What Rudder returns when `?tailLines=` is absent or unreadable. */
export const DEFAULT_TAIL_LINES = 1000;

/**
 * Parse `?tailLines=`, clamped to `MAX_TAIL_LINES`.
 *
 * Absent, non-numeric and non-positive all mean the default: `parseInt('abc')`
 * is `NaN`, which Podman turns into an empty log rather than an error, so a
 * typo would silently look like a container that had printed nothing.
 */
export function parseTailLines(raw: string | null): number {
  if (raw === null) return DEFAULT_TAIL_LINES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TAIL_LINES;
  return Math.min(parsed, MAX_TAIL_LINES);
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
    exposedPorts: string | null;
    appsecDisabledRules: string | null;
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

  // Environment values flagged `secret` are withheld, not rendered.
  //
  // `applications.environment` is `[{ key, value, secret }]`, and
  // /api/applications/[id]/export has always replaced the value of a
  // secret-flagged entry before returning it. This mapper ignored the flag
  // entirely, so `kubectl get deploy -o yaml` handed the plaintext to any
  // team-scoped API key — the values the REST export deliberately hides.
  //
  // Withheld by omission rather than by a placeholder value, which is where
  // this differs from the export: that endpoint is read-only, while this one is
  // half of an apply loop. A `***REDACTED***` string here would be read back by
  // `parseDeploymentBody` on the next `kubectl apply` and stored as if it were
  // the real value, quietly replacing the secret with the marker. The names are
  // still reported, so the output says what it is not showing.
  const envVars: Array<{ name: string; value: string }> = [];
  const withheldEnv: string[] = [];
  if (app.environment) {
    try {
      const arr = JSON.parse(app.environment);
      for (const e of arr) {
        if (e?.secret) {
          withheldEnv.push(e.key);
        } else {
          envVars.push({ name: e.key, value: e.value || '' });
        }
      }
    } catch {
      /* ignore */
    }
  }

  const declaredPorts = parseExposedPorts(app.exposedPorts);
  const disabledRules = parseAppsecRules(app.appsecDisabledRules);

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
        // Emitted, not only read. Without this,
        // `kubectl get deploy x -o yaml | kubectl apply -f -` drops the
        // declaration and the extra ports go dark on the next apply, with
        // nothing in the output to explain why.
        ...(declaredPorts ? { 'rudder.dev/expose-ports': declaredPorts.join(',') } : {}),
        // Emitted for the same round-trip reason. Losing this on an apply
        // silently re-enables rules an application was exempt from, and the
        // first sign of it is a user being banned.
        ...(disabledRules.length > 0
          ? { 'rudder.dev/appsec-disable-rules': disabledRules.join(',') }
          : {}),
        // Names only. Says which variables exist without showing their values,
        // so a withheld secret does not look like a missing one.
        ...(withheldEnv.length > 0
          ? { 'rudder.dev/withheld-env': withheldEnv.join(',') }
          : {}),
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
 * One container, reported as one Pod.
 *
 * `Pod` is the only Kubernetes noun for a running thing, so a kubectl-compatible
 * API has to emit them — but the mapping stays one-to-one, because that is what
 * Rudder actually runs. Grouping an application's containers into a single Pod
 * with several containers listed would claim the thing this architecture
 * deliberately does not provide: a shared network namespace, and therefore
 * `localhost` between them. Every container here has its own address on a
 * bridge and reaches its siblings by name.
 *
 * The deployment records a note saying so whenever a manifest has more than one
 * container, which is where that belongs — in the history of the deploy, not
 * implied by the shape of a status object.
 */
export function containerToPod(container: PodContainerRow, appName: string, teamSlug: string) {
  const phase = phaseOf(container.status);
  const containerPort = containerPortOf(container.ports, container.exposedPort);
  const name = podNameOf(container.name);

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
      name,
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
          name,
          image: container.image,
          ...(containerPort ? { ports: [{ containerPort, protocol: 'TCP' }] } : {}),
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
          name,
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
  exposedPorts?: number[] | null;
  appsecDisabledRules?: AppsecRuleId[] | null;
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

  // Refused rather than ignored. kubectl has no other feedback channel: a
  // silently dropped annotation leaves the user with an application that is
  // unreachable on a port they believe they configured, and an `apply` that
  // reported success.
  const exposeAnnotation = body.metadata?.annotations?.['rudder.dev/expose-ports'];
  let exposedPorts: number[] | null = null;
  if (exposeAnnotation !== undefined) {
    exposedPorts = parsePortList(String(exposeAnnotation));
    if (exposedPorts === null) {
      throw new Error(
        `rudder.dev/expose-ports must be a comma-separated list of container ports, ` +
          `for example "7070,8080" — got "${exposeAnnotation}"`,
      );
    }
    if (exposedPorts.length > MAX_ROUTES_PER_CONTAINER) {
      throw new Error(
        `rudder.dev/expose-ports names ${exposedPorts.length} ports; a worker has ` +
          `${MAX_ROUTES_PER_CONTAINER} HTTPS entryPoints`,
      );
    }
  }

  // Same contract as expose-ports: refused rather than ignored. Someone who
  // mistypes a rule id and is told nothing believes the rule is off, and goes on
  // being banned by it with no sign that anything is wrong.
  const appsecAnnotation = body.metadata?.annotations?.['rudder.dev/appsec-disable-rules'];
  let appsecDisabledRules: AppsecRuleId[] | null = null;
  if (appsecAnnotation !== undefined) {
    appsecDisabledRules = parseRuleList(String(appsecAnnotation));
    if (appsecDisabledRules === null) {
      throw new Error(
        `rudder.dev/appsec-disable-rules must be a comma-separated list of CRS rule numbers ` +
          `or CrowdSec rule names, for example "942100,crowdsecurity/vpatch-git-config" — ` +
          `got "${appsecAnnotation}"`,
      );
    }
    // kubectl has to refuse the anomaly gate for the same reason the forms do,
    // or `kubectl apply` becomes the way around it.
    const refusal = firstRuleRefusal(appsecDisabledRules);
    if (refusal) throw new Error(refusal);
  }

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
    exposedPorts,
    appsecDisabledRules,
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

