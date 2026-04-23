import { z } from 'zod';

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

export const schemas = {
  workerId: z.string().uuid().min(1),
  containerId: z.string().min(1).max(256),
  teamId: z.string().uuid().min(1),
  userId: z.string().uuid().min(1),
  applicationId: z.string().uuid().min(1),
  sshKeyId: z.string().uuid().min(1),
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
  
  domain: z.string()
    .min(1, 'Domain is required')
    .max(253, 'Domain too long')
    .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
      'Invalid domain format'),
  
  dockerImage: z.string()
    .min(1, 'Image is required')
    .max(500, 'Image name too long')
    .regex(/^[a-zA-Z0-9._/-]+(:[a-zA-Z0-9._-]+)?$/, 'Invalid image format'),

  createWorker: z.object({
    name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Name can only contain letters, numbers, underscores, and hyphens'),
    hostname: z.string().min(1).max(253),
    sshPort: z.number().int().min(1).max(65535).default(22),
    sshUser: z.string().min(1).max(100),
    sshKeyId: z.string().uuid(),
    baseDomain: z.string().max(253).optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }),

  provisionWorker: z.object({
    workerId: z.string().uuid(),
  }),

  terminalCommand: z.object({
    command: z.string().min(1).max(10000),
  }),

  terminalToken: z.object({
    containerId: z.string().optional(),
    workerId: z.string().optional(),
  }),

  createApplication: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    domain: z.string().max(253).optional(),
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

  createTeam: z.object({
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  }),

  createSecret: z.object({
    name: z.string().min(1).max(100).regex(/^[A-Z_][A-Z0-9_]*$/, 'Secret name must be uppercase with underscores'),
    value: z.string().min(1).max(10000),
    description: z.string().max(500).optional(),
    scope: z.enum(['global', 'team']).default('team'),
    teamId: z.string().uuid().optional(),
  }),

  createApiKey: z.object({
    name: z.string().min(1).max(100),
    teamId: z.string().uuid().optional(),
    expiresAt: z.string().datetime().optional(),
  }),

  addTeamMember: z.object({
    userId: z.string().uuid(),
    role: z.enum(['owner', 'member']).default('member'),
  }),

  containerAction: z.object({
    action: z.enum(['start', 'stop', 'restart', 'remove']),
    timeout: z.number().int().min(0).max(300).optional(),
  }),

  containerExec: z.object({
    cmd: z.array(z.string()).min(1).max(100),
    tty: z.boolean().optional(),
  }),

  createSshKey: z.object({
    name: z.string().min(1).max(100),
    privateKey: z.string().min(1).max(50000),
    publicKey: z.string().min(1).max(10000),
  }),

  createVolume: z.object({
    name: z.string().min(1).max(100),
    workerId: z.string().uuid(),
    teamId: z.string().uuid().optional(),
    containerPath: z.string().min(1).max(500),
    sizeLimit: z.number().int().positive().optional(),
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
  }),

  seedAdmin: z.object({
    token: z.string().min(1),
  }),

  registerWorker: z.object({
    name: z.string().min(1).max(100),
    hostname: z.string().min(1).max(253),
    secret: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
  }),

  userUpdate: z.object({
    fullName: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'member']).optional(),
  }),
};
