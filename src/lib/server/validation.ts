import { z } from 'zod';
import { MAX_ROUTES_PER_CONTAINER } from './deploy/plan';
import { domainFormatError } from './domains';
import { hostnameFormatError, sshUserFormatError } from './ssh-target';

export function parseBody<T extends z.ZodTypeAny>(
  body: unknown,
  schema: T
): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = result.error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new ValidationError(`Validation failed: ${errors}`);
  }
  return result.data;
}

export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  return parseBody(body, schema);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * A hostname Rudder will put in a Traefik router rule.
 *
 * Built on `domainFormatError` rather than its own regex. The two used to be
 * separate, this one went unused, and the hostname that actually reached a
 * router rule was never checked at all. Declared outside `schemas` so the
 * object's own fields can reuse it.
 */
const domainSchema = z.string().superRefine((value, ctx) => {
  const error = domainFormatError(value);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

/** Built on the same rule the SSH layer enforces; see `ssh-target.ts`. */
function refined(check: (value: string) => string | null) {
  return z.string().superRefine((value, ctx) => {
    const error = check(value);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  });
}

/**
 * A worker's SSH destination.
 *
 * These were `z.string().min(1).max(253)` and `z.string().min(1).max(100)`, so
 * a length was the only thing asked of a value that becomes the `user@host`
 * argument of an `ssh` invocation — where anything starting with a dash is read
 * as an option rather than a destination.
 */
const sshHostSchema = refined(hostnameFormatError);
const sshUserSchema = refined(sshUserFormatError);

export const schemas = {
  workerId: z.string().uuid().min(1),
  containerId: z.string().min(1).max(256),
  teamId: z.string().uuid().min(1),
  userId: z.string().uuid().min(1),
  applicationId: z.string().uuid().min(1),
  secretId: z.string().uuid().min(1),
  
  hostname: z.string()
    .min(1, 'Hostname is required')
    .max(253, 'Hostname too long')
    .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/, 
      'Invalid hostname format'),
  
  port: z.number().int().min(1).max(65535),
  
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name can only contain letters, numbers, underscores, and hyphens'),
  
  displayName: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long'),
  
  email: z.string().email('Invalid email format'),
  
  command: z.string()
    .min(1, 'Command is required')
    .max(10000, 'Command too long'),
  
  domain: domainSchema,

  dockerImage: z.string()
    .min(1, 'Image is required')
    .max(500, 'Image name too long')
    .regex(/^[a-zA-Z0-9._/-]+(:[a-zA-Z0-9._-]+)?$/, 'Invalid image format'),

  /**
   * Container ports to publish, in the order they take Traefik entryPoints.
   *
   * Capped at the number of entryPoints a worker has, so an over-long list is
   * refused where the person can fix it rather than accepted and truncated at
   * deploy time. Duplicates are refused for the same reason: `[80, 80]` has no
   * sensible reading, and picking one silently is how a route ends up somewhere
   * its author did not put it.
   */
  exposedPorts: z
    .array(z.number().int().min(1).max(65535))
    .max(MAX_ROUTES_PER_CONTAINER, `At most ${MAX_ROUTES_PER_CONTAINER} ports can be published`)
    .refine((ports) => new Set(ports).size === ports.length, 'Ports must be distinct'),

  createWorker: z.object({
    name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name can only contain letters, numbers, underscores, and hyphens'),
    hostname: sshHostSchema,
    sshPort: z.number().int().min(1).max(65535).default(22),
    sshUser: sshUserSchema,
    /**
     * Every hostname on the worker is built from this, and each one becomes a
     * Traefik `Host()` rule — so it gets the same check an application domain
     * does, not a bare length cap.
     */
    baseDomain: domainSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }),

  provisionWorker: z.object({
    workerId: z.string().uuid(),
    sshPrivateKey: z.string().min(1).max(50000),
    /**
     * Install pending host package updates as part of this run. Defaults to
     * true so re-provisioning is a patching event; callers with their own
     * patch pipeline, or in a hurry, can turn it off and still get the count
     * reported in the log.
     */
    applyUpdates: z.boolean().default(true),
  }),

  terminalCommand: z.object({
    command: z.string().min(1).max(10000),
    sshPrivateKey: z.string().min(1).max(50000).optional(),
  }),

  terminalToken: z.object({
    containerId: z.string().optional(),
    workerId: z.string().optional(),
  }),

  createApplication: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    domain: domainSchema.optional(),
    workerId: z.string().uuid(),
    teamId: z.string().uuid(),
    type: z.enum(['single', 'compose', 'k8s']).default('single'),
    manifest: z.string().max(100000).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    volumes: z.array(z.string()).optional(),
    restartPolicy: z.enum(['no', 'on-failure', 'always', 'unless-stopped']).default('always'),
  }),

  deployApplication: z.object({
    applicationId: z.string().uuid(),
  }),

  /**
   * The slug is derived from the name by `/api/teams`, not supplied.
   *
   * This used to require one, which is why the endpoint never adopted the
   * schema: applying it as written would have rejected every request the UI
   * actually sends. A schema no caller can satisfy is worse than none — it
   * looks like validation and is dead code.
   */
  createTeam: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
  }),

  createSecret: z.object({
    name: z.string().min(1).max(100).regex(/^[A-Z_][A-Z0-9_]*$/, 'Secret name must be uppercase with underscores'),
    value: z.string().min(1).max(10000),
    description: z.string().max(500).optional(),
    scope: z.enum(['global', 'team']).default('team'),
    /**
     * `env` keeps the historical behaviour. `file` writes the value to
     * /run/secrets/<name> instead, where it is absent from `podman inspect`
     * and from the process environment. Defaults to `env` because switching
     * delivery under a running application breaks it.
     */
    deliveryMode: z.enum(['env', 'file']).default('env'),
    teamId: z.string().uuid().optional(),
  }),

  /**
   * Every field optional but the id — a PATCH that only changes the description
   * must not have to resend the value. Scope and team are deliberately absent:
   * moving a secret between scopes changes which containers receive it, which
   * is a create-and-delete, not an edit.
   */
  updateSecret: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100).regex(/^[A-Z_][A-Z0-9_]*$/, 'Secret name must be uppercase with underscores').optional(),
    value: z.string().min(1).max(10000).optional(),
    description: z.string().max(500).optional(),
    deliveryMode: z.enum(['env', 'file']).optional(),
  }),

  createApiKey: z.object({
    name: z.string().min(1).max(100),
    /** Omit for a global (all-teams) key — admin only. */
    teamId: z.string().uuid().optional().nullable(),
    expiresInDays: z.number().int().positive().max(3650).optional(),
  }),

  addTeamMember: z.object({
    userId: z.string().uuid(),
  }),

  containerAction: z.object({
    action: z.enum(['start', 'stop', 'restart', 'remove']),
    timeout: z.number().int().min(0).max(300).optional(),
  }),

  containerExec: z.object({
    cmd: z.array(z.string()).min(1).max(100),
    tty: z.boolean().optional(),
  }),

  /**
   * `teamId` is required and `workerId` is not — the reverse of what this said.
   *
   * Every volume must have an owning team: a teamless one is invisible in the
   * listing (which filters on membership) but was readable, editable and
   * deletable by every authenticated user, because the per-volume checks skip
   * membership when there is no team to check against. A volume not yet pinned
   * to a worker is ordinary; `volumes.worker_id` is nullable.
   */
  createVolume: z.object({
    name: z.string().min(1).max(100),
    teamId: z.string().uuid(),
    workerId: z.string().uuid().nullable().optional(),
    containerPath: z.string().min(1).max(500),
    sizeLimit: z.number().int().positive().nullable().optional(),
  }),

  saveTemplate: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    sourceAppId: z.string().uuid(),
    teamId: z.string().uuid(),
    shared: z.boolean().default(false),
  }),

  oidcConfig: z.object({
    enabled: z.boolean(),
    providerName: z.string().max(100).optional(),
    issuerUrl: z.string().url().max(500).optional(),
    clientId: z.string().max(200).optional(),
    clientSecret: z.string().max(500).optional(),
    authorizationEndpoint: z.string().url().max(500).optional(),
    tokenEndpoint: z.string().url().max(500).optional(),
    userinfoEndpoint: z.string().url().max(500).optional(),
    jwksUri: z.string().url().max(500).optional(),
    scopes: z.string().max(500).optional(),
    usePkce: z.boolean().optional(),
    allowRegistration: z.boolean().optional(),
    teamClaimName: z.string().max(100).optional(),
    teamClaimKey: z.string().max(100).optional(),
    teamRoleSuffix: z.string().max(100).optional(),
  }),

  seedAdmin: z.object({
    token: z.string().min(1),
  }),

  registerWorker: z.object({
    name: z.string().min(1).max(100),
    hostname: sshHostSchema,
    secret: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
  }),

  userUpdate: z.object({
    fullName: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'member']).optional(),
  }),
};
