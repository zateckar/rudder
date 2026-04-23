import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
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

export const teamMembers = sqliteTable('team_members', {
  teamId: text('team_id').notNull().references(() => teams.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
  joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull(),
});

export const workers = sqliteTable('workers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  sshUser: text('ssh_user').notNull(),
  sshKeyId: text('ssh_key_id').references(() => sshKeys.id),
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
});

export const sshKeys = sqliteTable('ssh_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  privateKey: text('private_key').notNull(),
  publicKey: text('public_key').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  usedForProvisioning: integer('used_for_provisioning', { mode: 'boolean' }).notNull().default(false),
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
  authType: text('auth_type', { enum: ['none', 'oidc'] }).notNull().default('none'),
  authConfig: text('auth_config'),
  stackId: text('stack_id').references(() => stacks.id),
  replicas: integer('replicas').notNull().default(1),
  gitRepo: text('git_repo'),
  gitBranch: text('git_branch'),
  gitDockerfile: text('git_dockerfile'),
  healthcheck: text('healthcheck'), // JSON: { test, interval, timeout, retries }
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
  labels: text('labels'),
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
  status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed', 'rolled_back'] }).notNull().default('pending'),
  deployedBy: text('deployed_by').references(() => users.id),
  errorMessage: text('error_message'),
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

/** Application stacks / groups */
export const stacks = sqliteTable('stacks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  teamId: text('team_id').references(() => teams.id),
  createdBy: text('created_by').references(() => users.id),
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
