import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  /** Last authenticated request, throttled — see `touchLastSeen` in hooks.server.ts. */
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const userOidc = sqliteTable('user_oidc', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider', { enum: ['google', 'github', 'okta', 'auth0'] }).notNull(),
  providerId: text('provider_id').notNull(),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
});

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Who is in a team. Flat: a team has members, and that is the whole model.
 *
 * There used to be an `owner` role here, a second and weaker administrator tier
 * that could rename and delete its team, manage its membership and mint its API
 * keys. It bought little — an installation admin could already do all of it — and
 * cost a great deal of conditional logic, including an exemption in the OIDC
 * claim sync that existed only so hand-granted access had somewhere to hide.
 * Team lifecycle and membership are now admin work; everything a team *owns* is
 * open to every member of it.
 */
export const teamMembers = sqliteTable('team_members', {
  teamId: text('team_id').notNull().references(() => teams.id),
  userId: text('user_id').notNull().references(() => users.id),
  joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull(),
});

export const workers = sqliteTable('workers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  sshUser: text('ssh_user').notNull(),
  podmanApiUrl: text('podman_api_url').notNull(),
  podmanCaCert: text('podman_ca_cert'),
  podmanClientCert: text('podman_client_cert'),
  podmanClientKey: text('podman_client_key'),
  baseDomain: text('base_domain'),
  crowdsecBouncerKey: text('crowdsec_bouncer_key'),
  status: text('status', { enum: ['online', 'offline', 'provisioning', 'error'] }).notNull().default('provisioning'),
  labels: text('labels'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  provisionedAt: integer('provisioned_at', { mode: 'timestamp' }),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  oidcEnabled: integer('oidc_enabled', { mode: 'boolean' }).notNull().default(false),
  oidcProviderUrl: text('oidc_provider_url'),
  oidcClientId: text('oidc_client_id'),
  oidcClientSecret: text('oidc_client_secret'),
  /** Plugin `Secret` (32 chars), encrypted at rest. */
  oidcEncryptionKey: text('oidc_encryption_key'),
  /**
   * Path of the shared callback URL on `auth.<baseDomain>`.
   *
   * Null means `OIDC_CALLBACK_PATH`. Identity providers compare redirect URIs
   * by exact string, so a client registered against another convention —
   * `/oauth2/callback` is the common one — needs its path named here or every
   * login ends at "invalid redirect_uri".
   */
  oidcCallbackPath: text('oidc_callback_path'),
  /**
   * When the current OIDC config was last written to the worker's Traefik.
   * Cleared whenever the config changes.  Deploys refuse to attach
   * `global-oidc@file` while this is null, because a router referencing a
   * middleware that does not exist on the worker is dropped by Traefik — the
   * app would 404 rather than prompt for login.
   */
  oidcAppliedAt: integer('oidc_applied_at', { mode: 'timestamp' }),
  /**
   * Where this worker's Traefik gets its routing configuration.
   *
   * `labels` — stamped into container labels at creation time, read by
   *   Traefik's docker provider. The original design; a routing change needs a
   *   redeploy.
   * `http` — generated from this database and fetched by the worker into
   *   `/etc/traefik/dynamic/routes.yml`, where the file provider picks it up.
   *
   * A worker must be wholly in one mode: both providers defining the same
   * router name would produce two routers with one `Host()` rule and arbitrary
   * resolution between them. Per-worker so the cutover can be watched on one
   * machine before the fleet follows.
   */
  routingMode: text('routing_mode', { enum: ['labels', 'http'] }).notNull().default('labels'),
  /** Bearer token the worker presents to the config endpoint, encrypted at rest. */
  configToken: text('config_token'),
  /**
   * HTTP Basic credentials for whatever sits in front of the control plane.
   *
   * Some deployments publish Rudder behind a proxy that demands its own
   * authentication. That proxy answers the worker's routing fetch with a 401
   * before Rudder ever sees it, which is indistinguishable from Rudder
   * rejecting the bearer token unless you read `WWW-Authenticate`.
   *
   * When set, the worker sends these as `Authorization: Basic` and moves its own
   * credential to `X-Rudder-Config-Token` — the two cannot share one header, and
   * the outer layer is the one that must be satisfied first.
   *
   * The password is encrypted at rest and never serialised to the browser.
   */
  configBasicUser: text('config_basic_user'),
  configBasicPassword: text('config_basic_password'),
  /** Last time this worker successfully fetched its routing configuration. */
  configFetchedAt: integer('config_fetched_at', { mode: 'timestamp' }),
  /**
   * Outcome of the worker's last routing-fetch *attempt*, reported by the worker
   * over the metrics endpoint.
   *
   * Distinct from `configFetchedAt`, which only ever records success. A worker
   * that is failing to fetch looks exactly like one that was never provisioned
   * for it — both leave `configFetchedAt` null — and the two need opposite
   * remedies. These columns are what tells them apart:
   *
   * - `configFetchStatus` — HTTP status the worker saw, or 0 when it could not
   *   reach the control plane at all.
   * - `configFetchDetail` — one of `ok`, `no-routes`, `transport`, `http`,
   *   `not-a-document`, `no-token`.
   *
   * Null on labels-mode workers and on any worker that has not reported yet.
   */
  configFetchStatus: integer('config_fetch_status'),
  configFetchDetail: text('config_fetch_detail'),
  configFetchAttemptAt: integer('config_fetch_attempt_at', { mode: 'timestamp' }),
});

export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  teamId: text('team_id').references(() => teams.id),
  workerId: text('worker_id').references(() => workers.id),
  name: text('name').notNull(),
  description: text('description'),
  domain: text('domain'),
  type: text('type', { enum: ['single', 'compose', 'k8s'] }).notNull().default('single'),
  deploymentFormat: text('deployment_format', { enum: ['compose', 'k8s'] }).notNull().default('compose'),
  manifest: text('manifest'),
  environment: text('environment'),
  volumes: text('volumes'),
  restartPolicy: text('restart_policy', { enum: ['no', 'on-failure', 'always', 'unless-stopped'] }).notNull().default('always'),
  rateLimitAvg: integer('rate_limit_avg'),
  rateLimitBurst: integer('rate_limit_burst'),
  authType: text('auth_type', { enum: ['none', 'oidc', 'global'] }).notNull().default('global'),
  authConfig: text('auth_config'),
  replicas: integer('replicas').notNull().default(1),
  gitRepo: text('git_repo'),
  gitBranch: text('git_branch'),
  gitDockerfile: text('git_dockerfile'),
  healthcheck: text('healthcheck'), // JSON: { test, interval, timeout, retries }
  /**
   * How long a blue/green deploy waits for the new generation to become
   * healthy before giving up and removing it. Null means the default.
   */
  healthTimeoutSeconds: integer('health_timeout_seconds'),
  /**
   * Minutes to keep the superseded generation stopped-but-present after a
   * successful deploy, so a rollback can restart it instead of pulling and
   * recreating. 0 — the default — reaps it immediately, which is the behaviour
   * of every deploy before this setting existed.
   */
  retainPreviousMinutes: integer('retain_previous_minutes').notNull().default(0),
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const applicationTemplates = sqliteTable('application_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  sourceAppId: text('source_app_id').references(() => applications.id),
  teamId: text('team_id').notNull().references(() => teams.id),
  shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
  type: text('type', { enum: ['single', 'compose', 'k8s'] }).notNull().default('single'),
  deploymentFormat: text('deployment_format', { enum: ['compose', 'k8s'] }).notNull().default('compose'),
  manifest: text('manifest'),
  environment: text('environment'),
  volumes: text('volumes'),
  restartPolicy: text('restart_policy', { enum: ['no', 'on-failure', 'always', 'unless-stopped'] }).notNull().default('always'),
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const containers = sqliteTable('containers', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').references(() => applications.id),
  workerId: text('worker_id').references(() => workers.id),
  containerId: text('container_id').notNull(),
  name: text('name').notNull(),
  image: text('image').notNull(),
  status: text('status').notNull(),
  ports: text('ports'),
  exposedPort: integer('exposed_port'),
  /**
   * Hostname this container is routed at, and the Traefik router/service name
   * carrying it. Written at deploy time by every path (single, compose, k8s).
   *
   * Routing configuration for `http`-mode workers is generated from these two
   * columns plus the application row: the hostname is a property of what was
   * deployed, while rate limits, auth mode and middleware chains come from the
   * application and are therefore editable without recreating anything.
   * Replicas of one application share a domain and router name, which is what
   * lets the generator emit a single service with several servers.
   */
  domain: text('domain'),
  routerName: text('router_name'),
  labels: text('labels'),
  /**
   * Which deploy produced this container. Two generations of one application
   * coexist during a blue/green cutover, which is only possible because the
   * generation is part of the Podman name — names are unique per host, and the
   * old scheme reused one, so the new container could not be created until the
   * old one was gone.
   */
  generation: integer('generation').notNull().default(1),
  /**
   * The deploy that created this container. What makes a fast rollback
   * possible: given a deployment the user picked out of the history, this is
   * how Rudder knows whether its containers are still sitting on the worker,
   * stopped, waiting to be restarted.
   */
  deploymentId: text('deployment_id'),
  /**
   * `pending`  — created, not yet verified, never routed.
   * `active`   — serving traffic.
   * `draining` — superseded; removed from the routing config, still running so
   *              in-flight requests can finish, and retained beyond that when
   *              the application opts into a fast-rollback window.
   *
   * Rows survive until after cutover so `reservedPortsForWorker` still counts
   * the ports the old generation holds.
   */
  state: text('state', { enum: ['pending', 'active', 'draining'] }).notNull().default('active'),
  /**
   * Hash of the parts of this container's intent that can only be changed by
   * recreating it — image, entrypoint, command, environment, mounts, resource
   * limits, health check, restart policy.
   *
   * Deliberately excludes everything a worker in `http` routing mode now fetches
   * live: the domain, router name, rate limits, auth mode and middleware chain.
   * That exclusion is the point. Without it the reconciler would call a
   * container stale — and therefore want a new generation — every time someone
   * edited a rate limit, which is exactly the redeploy 2-02 removed the need
   * for.
   *
   * Null on containers deployed before this column existed, and on adopted
   * containers, neither of which Rudder can claim to know the intent of. A null
   * hash never reads as stale.
   */
  specHash: text('spec_hash'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id),
  teamId: text('team_id').references(() => teams.id),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  details: text('details'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const volumes = sqliteTable('volumes', {
  id: text('id').primaryKey(),
  teamId: text('team_id').references(() => teams.id),
  workerId: text('worker_id').references(() => workers.id),
  name: text('name').notNull(),
  containerPath: text('container_path').notNull(),
  sizeLimit: integer('size_limit'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  teamId: text('team_id').references(() => teams.id),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Secrets store — global (admin) or team-scoped environment variables for containers */
export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  value: text('value').notNull(),
  description: text('description'),
  scope: text('scope', { enum: ['global', 'team'] }).notNull().default('team'),
  /**
   * How the value reaches the container.
   *
   * `env` — an environment variable. Visible in `podman inspect`, in
   *   `/proc/<pid>/environ` for anything running in the container, and to every
   *   child process. The historical behaviour, and still the default because
   *   most images read their configuration this way.
   * `file` — written to `/run/secrets/<name>` on a tmpfs, mode 0400, following
   *   the Docker/Podman secrets convention that many images already support.
   *   Absent from `podman inspect` and from the process environment.
   */
  deliveryMode: text('delivery_mode', { enum: ['env', 'file'] }).notNull().default('env'),
  teamId: text('team_id').references(() => teams.id),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Time-series container performance metrics collected in the background */
export const containerMetrics = sqliteTable('container_metrics', {
  id: text('id').primaryKey(),
  containerId: text('container_id').notNull(),  // references containers.id (no FK for perf)
  collectedAt: integer('collected_at', { mode: 'timestamp' }).notNull(),
  cpuPercent: real('cpu_percent'),
  memUsageBytes: integer('mem_usage_bytes'),
  memLimitBytes: integer('mem_limit_bytes'),
  memPercent: real('mem_percent'),
  netRxBytes: integer('net_rx_bytes'),
  netTxBytes: integer('net_tx_bytes'),
  blockReadBytes: integer('block_read_bytes'),
  blockWriteBytes: integer('block_write_bytes'),
});

/** Generic OIDC provider configuration (Auth Code + PKCE, stored in DB) */
export const oidcConfig = sqliteTable('oidc_config', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  providerName: text('provider_name').notNull().default('Generic OIDC'),
  issuerUrl: text('issuer_url'),
  clientId: text('client_id'),
  clientSecret: text('client_secret'),
  authorizationEndpoint: text('authorization_endpoint'),
  tokenEndpoint: text('token_endpoint'),
  userinfoEndpoint: text('userinfo_endpoint'),
  jwksUri: text('jwks_uri'),
  scopes: text('scopes').default('openid email profile'),
  usePkce: integer('use_pkce', { mode: 'boolean' }).default(true),
  allowRegistration: integer('allow_registration', { mode: 'boolean' }).default(true),
  teamClaimName: text('team_claim_name'),
  teamClaimKey: text('team_claim_key'),
  teamRoleSuffix: text('team_role_suffix'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Worker system metrics collected periodically */
export const workerMetrics = sqliteTable('worker_metrics', {
  id: text('id').primaryKey(),
  workerId: text('worker_id').notNull().references(() => workers.id),
  collectedAt: integer('collected_at', { mode: 'timestamp' }).notNull(),
  cpuPercent: real('cpu_percent'),
  memUsageBytes: integer('mem_usage_bytes'),
  memLimitBytes: integer('mem_limit_bytes'),
  memPercent: real('mem_percent'),
  diskUsageBytes: integer('disk_usage_bytes'),
  diskLimitBytes: integer('disk_limit_bytes'),
  diskPercent: real('disk_percent'),
  netRxBytes: integer('net_rx_bytes'),
  netTxBytes: integer('net_tx_bytes'),
  containersRunning: integer('containers_running'),
  containersTotal: integer('containers_total'),
  imagesCount: integer('images_count'),
  volumesCount: integer('volumes_count'),
  /**
   * Host patch state, scanned daily on the worker and cached — `apt-get -s
   * upgrade` is far too slow for the collection interval.
   *
   * Null means "not reported": a worker provisioned before this existed, or
   * one whose scan has never succeeded. Deliberately distinct from 0, which
   * claims the host is fully patched.
   */
  updatesPending: integer('updates_pending'),
  updatesSecurity: integer('updates_security'),
  rebootRequired: integer('reboot_required'),
});

/** Worker availability pings */
export const workerPings = sqliteTable('worker_pings', {
  id: text('id').primaryKey(),
  workerId: text('worker_id').notNull().references(() => workers.id),
  pingedAt: integer('pinged_at', { mode: 'timestamp' }).notNull(),
  status: text('status', { enum: ['online', 'offline', 'error'] }).notNull(),
  latencyMs: integer('latency_ms'),
  error: text('error'),
});

/** Deployment history -- tracks every deploy action for rollback */
export const deployments = sqliteTable('deployments', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull().references(() => applications.id),
  version: integer('version').notNull(),
  manifest: text('manifest'),
  environment: text('environment'),
  volumes: text('volumes'),
  image: text('image'),
  /**
   * The image digest this deployment actually ran, resolved from the registry
   * after the pull.
   *
   * `image` is the tag as written — `nginx:latest` — which is what the user
   * recognises but says nothing about which bytes ran. Rollback recreates
   * containers from the digest, so it restores what was running rather than
   * whatever the tag points at now. Null for deployments recorded before this
   * existed, and for images the registry reports no digest for.
   */
  imageDigest: text('image_digest'),
  status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed', 'rolled_back'] }).notNull().default('pending'),
  deployedBy: text('deployed_by').references(() => users.id),
  errorMessage: text('error_message'),
  /**
   * Things the manifest asked for that this deployment did not do exactly as
   * written — a Kubernetes semantic that does not survive translation to
   * containers on a bridge, a field Rudder ignores. JSON array of strings.
   *
   * Recorded rather than logged: a note in the control plane's stdout is the
   * same as the silence it replaced. These belong next to the deployment they
   * describe, where the person who wrote the manifest will see them.
   */
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});

/** Notification channels (email, webhook, slack) */
export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['webhook', 'slack', 'email'] }).notNull(),
  config: text('config').notNull(), // JSON: { url, headers } or { webhookUrl } or { smtp, to }
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  teamId: text('team_id').references(() => teams.id), // null = global
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Alert rules (configurable thresholds) */
export const alertRules = sqliteTable('alert_rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  resourceType: text('resource_type', { enum: ['worker', 'container', 'application'] }).notNull(),
  resourceId: text('resource_id'), // null = applies to all resources of this type
  metric: text('metric').notNull(), // cpu_percent, mem_percent, disk_percent, container_restarts
  operator: text('operator', { enum: ['gt', 'lt', 'gte', 'lte', 'eq'] }).notNull().default('gt'),
  threshold: real('threshold').notNull(),
  duration: integer('duration'), // seconds -- must exceed threshold for this long
  channelId: text('channel_id').references(() => notificationChannels.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  teamId: text('team_id').references(() => teams.id),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Alert history */
export const alertEvents = sqliteTable('alert_events', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').references(() => alertRules.id),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  metric: text('metric').notNull(),
  value: real('value').notNull(),
  threshold: real('threshold').notNull(),
  message: text('message').notNull(),
  acknowledged: integer('acknowledged', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/**
 * The most recent reconciliation pass for a worker.
 *
 * One row per worker, replaced wholesale each pass — this is a current-state
 * cache, not a history. Drift that persists is the same finding reported again,
 * and keeping every repetition would grow without bound while telling the
 * operator nothing the latest row does not.
 */
export const reconcileReports = sqliteTable('reconcile_reports', {
  workerId: text('worker_id').primaryKey().references(() => workers.id),
  ranAt: integer('ran_at', { mode: 'timestamp' }).notNull(),
  /** False when anything actionable disagrees. Foreign containers do not count. */
  clean: integer('clean', { mode: 'boolean' }).notNull().default(true),
  /** JSON `DriftEntry[]` — see src/lib/server/reconcile.ts. */
  findings: text('findings').notNull(),
  /** JSON `UnreconcilableApp[]`: applications whose intent could not be computed. */
  errors: text('errors'),
  /**
   * Hash of the actionable findings, so an unchanged problem is not notified
   * again on every cycle. Drift usually persists until someone fixes it; without
   * this, a single dead container would page the operator every five minutes.
   */
  fingerprint: text('fingerprint'),
});

/** Deploy webhooks / CI-CD triggers */
export const deployWebhooks = sqliteTable('deploy_webhooks', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull().references(() => applications.id),
  token: text('token').notNull(), // SHA-256 hashed
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Team resource quotas */
export const teamQuotas = sqliteTable('team_quotas', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id),
  maxCpuCores: real('max_cpu_cores'),
  maxMemoryBytes: integer('max_memory_bytes'),
  maxContainers: integer('max_containers'),
  maxApplications: integer('max_applications'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Azure Blob Storage backup configuration */
export const backupConfig = sqliteTable('backup_config', {
  id: text('id').primaryKey(),
  storageAccountName: text('storage_account_name').notNull(),
  accessKey: text('access_key').notNull(), // encrypted
  containerName: text('container_name').notNull().default('rudder-backups'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastBackupAt: integer('last_backup_at', { mode: 'timestamp' }),
  lastBackupStatus: text('last_backup_status'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Key-value system settings */
export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  oidc: many(userOidc),
  teamMembers: many(teamMembers),
  sessions: many(sessions),
}));

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  applications: many(applications),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const applicationsRelations = relations(applications, ({ one, many }) => ({
  team: one(teams, { fields: [applications.teamId], references: [teams.id] }),
  worker: one(workers, { fields: [applications.workerId], references: [workers.id] }),
  containers: many(containers),
}));

export const containersRelations = relations(containers, ({ one }) => ({
  application: one(applications, { fields: [containers.applicationId], references: [applications.id] }),
  worker: one(workers, { fields: [containers.workerId], references: [workers.id] }),
}));

export const workersRelations = relations(workers, ({ many }) => ({
  containers: many(containers),
  applications: many(applications),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
