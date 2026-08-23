/**
 * What an audited request actually did.
 *
 * The audit trail used to record the HTTP method as the action and the first
 * path segment as the resource, which the log page then rendered as CREATE for
 * every POST. Deploying, rolling back, reconciling, scaling and exec'ing a shell
 * inside a container are all POSTs, so the Action column said the same word for
 * all five and the only way to tell them apart was to read the URL out of the
 * details blob. Saving the application edit form is not an `/api/` call at all,
 * so it recorded resource `unknown`.
 *
 * Classifying here keeps that knowledge in one testable place rather than in a
 * chain of `startsWith` in the request hook.
 */

export interface AuditTarget {
  /** The verb, in the product's own vocabulary: DEPLOY, ROLLBACK, SCALE, EXEC… */
  action: string;
  /** What was acted on: application, worker, container, secret… */
  resourceType: string;
  /** The id from the path, when the route carries one. */
  resourceId: string | null;
}

/** Path segments that are verbs or collections, never an entity id. */
const NOT_AN_ID = new Set([
  'deploy', 'import', 'export', 'save', 'check', 'register', 'provision',
  'caddy', 'containers', 'events', 'logs', 'me', 'token', 'ws', 'trigger',
  'backup', 'apply', 'callback', 'generic', 'refresh', 'logout',
]);

/**
 * Whether a segment looks like something's id rather than a fixed route name.
 *
 * UUIDs cover applications, workers, teams, users, secrets and volumes.
 * Container ids are hex, and template ids are UUIDs too. Anything else is
 * treated as a route name, which is the safe direction to be wrong in: a
 * mislabelled id is noise in one column, an id mistaken for a route name only
 * costs the resourceId.
 */
function looksLikeId(segment: string): boolean {
  if (NOT_AN_ID.has(segment)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  return /^[0-9a-f]{12,64}$/i.test(segment);
}

/** The fallback verb, when the route says nothing more specific than its method. */
function verbForMethod(method: string): string {
  switch (method.toUpperCase()) {
    case 'POST': return 'CREATE';
    case 'PUT': return 'REPLACE';
    case 'PATCH': return 'UPDATE';
    case 'DELETE': return 'DELETE';
    default: return method.toUpperCase();
  }
}

/**
 * Routes whose last segment names the operation. `null` means "use the method",
 * which is right for collection endpoints where POST really does mean create.
 */
const OPERATION_BY_SEGMENT: Record<string, string | null> = {
  deploy: 'DEPLOY',
  deployments: 'ROLLBACK',
  reconcile: 'RECONCILE',
  scale: 'SCALE',
  import: 'IMPORT',
  export: 'EXPORT',
  exec: 'EXEC',
  recreate: 'RECREATE',
  image: 'CHANGE_IMAGE',
  provision: 'PROVISION',
  prune: 'PRUNE',
  adopt: 'ADOPT',
  collect: 'COLLECT',
  reconnect: 'RECONNECT',
  'routing-mode': 'SET_ROUTING_MODE',
  syslog: 'CONFIGURE_SYSLOG',
  oidc: 'CONFIGURE_OIDC',
  apply: 'APPLY',
  quota: 'SET_QUOTA',
  members: 'CHANGE_MEMBERS',
  webhook: 'CONFIGURE_WEBHOOK',
  trigger: 'TRIGGER',
  'traefik-config': 'CONFIGURE_TRAEFIK',
};

/** The first path segment of an `/api/` route mapped to what it operates on. */
const RESOURCE_BY_API_ROOT: Record<string, string> = {
  applications: 'application',
  workers: 'worker',
  containers: 'container',
  teams: 'team',
  users: 'user',
  secrets: 'secret',
  volumes: 'volume',
  templates: 'template',
  domains: 'domain',
  'api-keys': 'api_key',
  notifications: 'notification_channel',
  alerts: 'alert_rule',
  settings: 'settings',
  terminal: 'terminal',
  kubeconfig: 'kubeconfig',
  'key-envelope': 'key_envelope',
};

/**
 * Page routes that accept form actions. These are ordinary POSTs to the page's
 * own URL rather than to `/api/`, and they mutate exactly as much as an API
 * call does — the application edit form is one.
 */
const RESOURCE_BY_PAGE_ROOT: Record<string, string> = {
  applications: 'application',
  workers: 'worker',
  teams: 'team',
  admin: 'user',
  secrets: 'secret',
  volumes: 'volume',
  templates: 'template',
  settings: 'settings',
};

/**
 * Endpoints that use POST to observe rather than to change anything.
 *
 * `/api/workers/:id/info` reads a worker's system information and
 * `/api/workers/check` tests whether one answers. Both write — a ping row, the
 * worker's last-seen fields — but what they write is the control plane's own
 * telemetry, not an operator's decision. The worker page polls them, so
 * auditing them filled Recent Activity with ten identical rows and pushed the
 * deploy someone was looking for off the screen.
 *
 * Deliberately a short list of exact paths. The default is to audit; anything
 * added here has to be argued for.
 */
const OBSERVATION_ROUTES: ReadonlyArray<RegExp> = [
  /^\/api\/workers\/[^/]+\/info\/?$/,
  /^\/api\/workers\/check\/?$/,
];

/** Whether a mutating request is worth a row in the audit log. */
export function isAuditable(pathname: string): boolean {
  // Authentication has its own trail and must not have passwords near it.
  if (pathname.startsWith('/api/auth/')) return false;
  return !OBSERVATION_ROUTES.some((r) => r.test(pathname));
}

/**
 * Classify a mutating request for the audit log.
 *
 * `pathname` is the URL path; `search` is included because SvelteKit form
 * actions name themselves in the query string (`?/save`), which is the only
 * thing distinguishing one action on a page from another.
 */
export function classifyRequest(method: string, pathname: string, search = ''): AuditTarget {
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    return { action: verbForMethod(method), resourceType: 'unknown', resourceId: null };
  }

  // The Kubernetes-compatible surface keeps its own vocabulary — a kubectl user
  // reading this should see the verbs they issued.
  if (segments[0] === 'k8s') {
    return {
      action: verbForMethod(method),
      resourceType: `k8s_${segments[segments.length - 2] ?? 'resource'}`.toLowerCase(),
      resourceId: looksLikeId(segments[segments.length - 1]) ? segments[segments.length - 1] : null,
    };
  }

  const isApi = segments[0] === 'api';
  const route = isApi ? segments.slice(1) : segments;
  if (route.length === 0) {
    return { action: verbForMethod(method), resourceType: 'unknown', resourceId: null };
  }

  const resourceType = (isApi ? RESOURCE_BY_API_ROOT : RESOURCE_BY_PAGE_ROOT)[route[0]] ?? 'unknown';

  // The last id-shaped segment is the thing being acted on: `/api/workers/:id/
  // prune` is about the worker, `/api/containers/:id/exec` about the container.
  let resourceId: string | null = null;
  for (const segment of route) {
    if (looksLikeId(segment)) resourceId = segment;
  }

  // Verbs live at the end of the path — except for the page form actions, where
  // they live in the query string.
  const formAction = search.startsWith('?/') ? search.slice(2).split('&')[0] : null;
  const tail = route[route.length - 1];
  const operation = OPERATION_BY_SEGMENT[tail];

  let action: string;
  if (!isApi && formAction) {
    action = formAction.toUpperCase();
  } else if (operation) {
    // A DELETE against an operation route still deletes — `DELETE
    // /api/applications/:id/webhook` removes the webhook, it does not configure
    // one. Only the method-shaped default defers to the route's own name.
    action = method.toUpperCase() === 'DELETE' ? 'DELETE' : operation;
  } else {
    action = verbForMethod(method);
  }

  return { action, resourceType, resourceId };
}
