/**
 * The MCP tools: operating a team's applications.
 *
 * Scope is deliberately narrow. Everything here acts on applications that
 * belong to one of the caller's teams — the teams named by the token's
 * audience. There is nothing for workers, users, teams, secrets or settings,
 * and no way to create or delete an application: an agent can find out what is
 * running, deploy it, roll it back, start, stop, restart and scale it, and read
 * what happened.
 *
 * Every operation that changes something runs as a background task (see
 * tasks.ts) and returns its id at once; `get_task` reports progress.
 *
 * The tenancy rule is the one #lib/server/auth applies to sessions: an
 * application outside the caller's teams is "not found", never "forbidden", so
 * the tools cannot be used to learn which ids exist elsewhere.
 */
import { z } from 'zod';
import { db } from '#lib/db/index.ts';
import { applications, auditLogs, containers, deployments, workers } from '#lib/db/schema.ts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { executeApplicationDeploy } from '../deploy';
import { runLifecycleAction } from '../app-lifecycle';
import { rollbackToDeployment } from '../rollback';
import { LockError } from '../locks';
import { primaryUrl, serviceUrls } from '../app-urls';
import { withPodman } from '../podman-client';
import { parseCapturedOutput, tailChars } from '../deploy/failure-logs';
import type { McpPrincipal } from './auth';
import { deploymentForTask, getTask, listTasks, startTask, type Task, type TaskKind } from './tasks';

type Application = typeof applications.$inferSelect;
type Container = typeof containers.$inferSelect;

/** A failure the agent caused and can act on — reported as a tool error, not a protocol error. */
export class ToolError extends Error {}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolDefinition<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run: (principal: McpPrincipal, args: z.infer<S>) => Promise<Record<string, unknown>>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const applicationRef = z
  .string()
  .min(1)
  .describe('Application id, or its name (unique within the team).');

function iso(d: Date | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

function teamIds(principal: McpPrincipal): string[] {
  return principal.teams.map((t) => t.id);
}

function teamName(principal: McpPrincipal, id: string | null): string | null {
  return principal.teams.find((t) => t.id === id)?.name ?? null;
}

/** Narrow the caller's teams to one, when they named it. */
function scopedTeamIds(principal: McpPrincipal, team?: string): string[] {
  if (!team) return teamIds(principal);
  const key = team.toLowerCase();
  const match = principal.teams.find(
    (t) => t.id === team || t.name.toLowerCase() === key || t.slug.toLowerCase() === key,
  );
  if (!match) throw new ToolError(`Team "${team}" is not one of this token's teams.`);
  return [match.id];
}

/** An application the caller's teams own, by id or by name. */
async function findApplication(principal: McpPrincipal, ref: string): Promise<Application> {
  const ids = teamIds(principal);
  const byId = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, ref), inArray(applications.teamId, ids)))
    .get();
  if (byId) return byId;

  const candidates = await db.select().from(applications).where(inArray(applications.teamId, ids)).all();
  const named = candidates.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new ToolError(
      `More than one application is called "${ref}": ${named
        .map((a) => `${a.id} (team ${teamName(principal, a.teamId)})`)
        .join(', ')}. Use the id.`,
    );
  }
  throw new ToolError(`Application "${ref}" not found.`);
}

async function workerFor(app: Application) {
  if (!app.workerId) throw new ToolError(`Application "${app.name}" has no worker assigned, so it cannot run.`);
  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) throw new ToolError(`Application "${app.name}" is assigned to a worker that no longer exists.`);
  return worker;
}

function containerSummary(rows: readonly Container[]) {
  const active = rows.filter((c) => c.state === 'active');
  return {
    running: active.filter((c) => c.status === 'running').length,
    total: active.length,
  };
}

function containerView(c: Container) {
  return {
    name: c.name,
    image: c.image,
    status: c.status,
    state: c.state,
    generation: c.generation,
    desiredStatus: c.desiredStatus,
    domain: c.domain,
    updatedAt: iso(c.updatedAt),
  };
}

function deploymentView(d: typeof deployments.$inferSelect, withLogs = false) {
  let notes: string[] = [];
  try {
    const parsed = d.notes ? JSON.parse(d.notes) : [];
    if (Array.isArray(parsed)) notes = parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    /* rows predating the column */
  }
  return {
    id: d.id,
    version: d.version,
    status: d.status,
    image: d.image,
    imageDigest: d.imageDigest,
    errorMessage: d.errorMessage,
    notes,
    createdAt: iso(d.createdAt),
    finishedAt: iso(d.finishedAt),
    ...(withLogs ? { failureLogs: parseCapturedOutput(d.failureLogs) } : {}),
  };
}

async function taskView(task: Task) {
  const deployment = await deploymentForTask(task);
  return {
    taskId: task.id,
    kind: task.kind,
    status: task.status,
    application: { id: task.applicationId, name: task.applicationName },
    message: task.message,
    details: task.details,
    createdAt: iso(task.createdAt),
    finishedAt: iso(task.finishedAt),
    elapsedSeconds: Math.round(((task.finishedAt ?? new Date()).getTime() - task.createdAt.getTime()) / 1000),
    deployment: deployment ? deploymentView(deployment) : null,
    ...(task.status === 'running'
      ? { hint: 'Still running. Call get_task again in a few seconds.' }
      : task.status === 'failed' && deployment
        ? { hint: 'Call get_deployment with this deployment id for the failed containers\' output.' }
        : {}),
  };
}

function audit(principal: McpPrincipal, app: Application, action: string, details: Record<string, unknown>) {
  try {
    db.insert(auditLogs)
      .values({
        id: crypto.randomUUID(),
        userId: null,
        teamId: app.teamId,
        action,
        resourceType: 'application',
        resourceId: app.id,
        details: JSON.stringify({
          via: 'mcp',
          subject: principal.subject,
          clientId: principal.clientId,
          username: principal.username,
          ...details,
        }),
        createdAt: new Date(),
      })
      .run();
  } catch (e) {
    console.error('[mcp] Failed to write audit log:', e);
  }
}

/**
 * Start a background operation on `app`, after the checks every one of them
 * shares: the application can run somewhere, and nothing else started over MCP
 * is still running on it.
 */
async function launch(
  principal: McpPrincipal,
  app: Application,
  kind: TaskKind,
  auditAction: string,
  auditDetails: Record<string, unknown>,
  work: () => Promise<{ success: boolean; message: string; deploymentId?: string; details?: Record<string, unknown> }>,
) {
  await workerFor(app);
  const busy = listTasks({ teamIds: new Set([app.teamId!]), applicationId: app.id }).find(
    (t) => t.status === 'running',
  );
  if (busy) {
    throw new ToolError(
      `A ${busy.kind} of "${app.name}" is already running (task ${busy.id}). Wait for it with get_task.`,
    );
  }

  const task = startTask(
    { kind, applicationId: app.id, applicationName: app.name, teamId: app.teamId!, startedBy: principal.subject },
    async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof LockError) {
          return { success: false, message: 'Another operation is running on this application\'s worker. Try again when it finishes.' };
        }
        throw e;
      }
    },
  );
  audit(principal, app, auditAction, { taskId: task.id, ...auditDetails });
  return {
    taskId: task.id,
    status: task.status,
    message: `${kind} of "${app.name}" started. Poll get_task with this taskId for progress.`,
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

function defineTool<S extends z.ZodType>(tool: ToolDefinition<S>): ToolDefinition<S> {
  return tool;
}

const TOOLS = [
  defineTool({
    name: 'list_teams',
    title: 'List teams',
    description: 'The teams this access token acts for. Every other tool is limited to their applications.',
    input: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal) => ({
      teams: principal.teams.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
      ...(principal.skippedTeams.length ? { unresolvedAudiences: principal.skippedTeams } : {}),
    }),
  }),

  defineTool({
    name: 'list_applications',
    title: 'List applications',
    description:
      'Applications owned by your teams, with their URL, desired state, how many containers are running, and the latest deployment.',
    input: z.object({
      team: z.string().optional().describe('Restrict to one team (id, name or slug).'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal, args) => {
      const ids = scopedTeamIds(principal, args.team);
      const apps = await db.select().from(applications).where(inArray(applications.teamId, ids)).all();
      if (apps.length === 0) return { applications: [] };

      const appIds = apps.map((a) => a.id);
      const rows = await db.select().from(containers).where(inArray(containers.applicationId, appIds)).all();
      const workerRows = await db.select({ id: workers.id, name: workers.name }).from(workers).all();
      const workerName = new Map(workerRows.map((w) => [w.id, w.name]));

      const result = [];
      for (const app of apps.sort((a, b) => a.name.localeCompare(b.name))) {
        const own = rows.filter((c) => c.applicationId === app.id);
        const latest = await db
          .select()
          .from(deployments)
          .where(eq(deployments.applicationId, app.id))
          .orderBy(desc(deployments.version))
          .limit(1)
          .get();
        result.push({
          id: app.id,
          name: app.name,
          team: teamName(principal, app.teamId),
          type: app.type,
          url: primaryUrl(app.domain, own.filter((c) => c.state === 'active')),
          desiredStatus: app.desiredStatus,
          containers: containerSummary(own),
          worker: app.workerId ? (workerName.get(app.workerId) ?? null) : null,
          latestDeployment: latest
            ? { id: latest.id, version: latest.version, status: latest.status, createdAt: iso(latest.createdAt) }
            : null,
        });
      }
      return { applications: result };
    },
  }),

  defineTool({
    name: 'get_application',
    title: 'Get application',
    description:
      'Details of one application: its containers and their status, URLs, recent deployments and any task running on it.',
    input: z.object({ application: applicationRef }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      const own = await db.select().from(containers).where(eq(containers.applicationId, app.id)).all();
      const active = own.filter((c) => c.state === 'active');
      const recent = await db
        .select()
        .from(deployments)
        .where(eq(deployments.applicationId, app.id))
        .orderBy(desc(deployments.version))
        .limit(5)
        .all();
      const worker = app.workerId
        ? await db.select({ name: workers.name, status: workers.status }).from(workers).where(eq(workers.id, app.workerId)).get()
        : null;
      return {
        id: app.id,
        name: app.name,
        description: app.description,
        team: teamName(principal, app.teamId),
        type: app.type,
        desiredStatus: app.desiredStatus,
        replicas: app.replicas,
        restartPolicy: app.restartPolicy,
        autoUpdateEnabled: app.autoUpdateEnabled,
        url: primaryUrl(app.domain, active),
        services: serviceUrls(active),
        worker: worker ?? null,
        containers: own.map(containerView),
        recentDeployments: recent.map((d) => deploymentView(d)),
        tasks: await Promise.all(
          listTasks({ teamIds: new Set(teamIds(principal)), applicationId: app.id }).slice(0, 5).map(taskView),
        ),
        updatedAt: iso(app.updatedAt),
      };
    },
  }),

  defineTool({
    name: 'deploy_application',
    title: 'Deploy application',
    description:
      'Deploy the application\'s current configuration: pull images and roll out a new generation blue/green. ' +
      'Returns a taskId immediately; poll get_task until it is no longer running.',
    input: z.object({ application: applicationRef }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      return launch(principal, app, 'deploy', 'DEPLOY', {}, async () => {
        const result = await executeApplicationDeploy(app.id, null);
        return { success: result.success, message: result.message, deploymentId: result.deploymentId };
      });
    },
  }),

  defineTool({
    name: 'rollback_application',
    title: 'Roll back application',
    description:
      'Restore the configuration and exact image digests of an earlier deployment and redeploy it ' +
      '(or restart its retained containers when they are still on the worker). ' +
      'Find deployment ids with list_deployments. Returns a taskId; poll get_task.',
    input: z.object({
      application: applicationRef,
      deploymentId: z.string().min(1).describe('The deployment to roll back to.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      // Checked here as well as in the task so a wrong id is an immediate answer.
      const source = await db.select({ applicationId: deployments.applicationId }).from(deployments)
        .where(eq(deployments.id, args.deploymentId)).get();
      if (!source || source.applicationId !== app.id) {
        throw new ToolError(`Deployment "${args.deploymentId}" not found for application "${app.name}".`);
      }
      return launch(principal, app, 'rollback', 'ROLLBACK', { deploymentId: args.deploymentId }, async () => {
        const result = await rollbackToDeployment(app, args.deploymentId, null);
        return {
          success: result.success,
          message: result.message,
          deploymentId: result.deploymentId,
          details: result.fast ? { fast: true } : undefined,
        };
      });
    },
  }),

  defineTool({
    name: 'control_application',
    title: 'Start, stop or restart application',
    description:
      'Start, stop or restart the application\'s serving containers. A stop is remembered: the application stays ' +
      'stopped until started again. Returns a taskId; poll get_task.',
    input: z.object({
      application: applicationRef,
      action: z.enum(['start', 'stop', 'restart']),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      const worker = await workerFor(app);
      return launch(principal, app, args.action, args.action.toUpperCase(), {}, async () => {
        const result = await runLifecycleAction(app, worker, args.action);
        if (!result.found) return { success: false, message: 'Application no longer exists.' };
        return {
          success: result.success,
          message: result.message,
          details: result.failures.length ? { failures: result.failures } : undefined,
        };
      });
    },
  }),

  defineTool({
    name: 'scale_application',
    title: 'Scale application',
    description:
      'Change the number of replicas (1–10) of a single-container or Kubernetes-manifest application and redeploy. ' +
      'Returns a taskId; poll get_task.',
    input: z.object({
      application: applicationRef,
      replicas: z.number().int().min(1).max(10),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      if (app.type !== 'single' && app.type !== 'k8s') {
        throw new ToolError(`"${app.name}" is a ${app.type} application; only single-container and Kubernetes applications scale.`);
      }
      return launch(principal, app, 'scale', 'SCALE', { replicas: args.replicas }, async () => {
        const result = await executeApplicationDeploy(app.id, null, { replicas: args.replicas });
        return {
          success: result.success,
          message: result.success ? `Scaled to ${args.replicas} replica${args.replicas === 1 ? '' : 's'}. ${result.message}` : result.message,
          deploymentId: result.deploymentId,
        };
      });
    },
  }),

  defineTool({
    name: 'get_task',
    title: 'Get task progress',
    description:
      'Progress of a task started by deploy_application, rollback_application, control_application or scale_application: ' +
      'running, succeeded or failed, with the deployment it is producing.',
    input: z.object({ taskId: z.string().min(1) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal, args) => {
      const task = getTask(args.taskId);
      if (!task || !teamIds(principal).includes(task.teamId)) {
        throw new ToolError(
          `Task "${args.taskId}" not found. Tasks are kept for 24 hours and do not survive a Rudder restart; ` +
            'list_deployments shows what was deployed.',
        );
      }
      return taskView(task);
    },
  }),

  defineTool({
    name: 'list_tasks',
    title: 'List tasks',
    description: 'Recent tasks on your teams\' applications, newest first.',
    input: z.object({
      application: applicationRef.optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal, args) => {
      const app = args.application ? await findApplication(principal, args.application) : null;
      const found = listTasks({ teamIds: new Set(teamIds(principal)), applicationId: app?.id }).slice(0, args.limit ?? 20);
      return { tasks: await Promise.all(found.map(taskView)) };
    },
  }),

  defineTool({
    name: 'list_deployments',
    title: 'List deployments',
    description: 'Deployment history of an application, newest first — the ids rollback_application takes.',
    input: z.object({
      application: applicationRef,
      limit: z.number().int().min(1).max(50).optional().describe('Default 10.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.applicationId, app.id))
        .orderBy(desc(deployments.version))
        .limit(args.limit ?? 10)
        .all();
      return { application: { id: app.id, name: app.name }, deployments: rows.map((d) => deploymentView(d)) };
    },
  }),

  defineTool({
    name: 'get_deployment',
    title: 'Get deployment',
    description:
      'One deployment, including the output its containers printed if it failed (captured before they were removed).',
    input: z.object({ deploymentId: z.string().min(1) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (principal, args) => {
      const row = await db.select().from(deployments).where(eq(deployments.id, args.deploymentId)).get();
      const app = row
        ? await db.select().from(applications)
            .where(and(eq(applications.id, row.applicationId), inArray(applications.teamId, teamIds(principal))))
            .get()
        : undefined;
      if (!row || !app) throw new ToolError(`Deployment "${args.deploymentId}" not found.`);
      return { application: { id: app.id, name: app.name }, ...deploymentView(row, true) };
    },
  }),

  defineTool({
    name: 'get_application_logs',
    title: 'Get application logs',
    description: 'Recent output (stdout and stderr) of the application\'s serving containers.',
    input: z.object({
      application: applicationRef,
      tail: z.number().int().min(1).max(2000).optional().describe('Lines per container. Default 200.'),
      container: z.string().optional().describe('Only this container (by name).'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (principal, args) => {
      const app = await findApplication(principal, args.application);
      const worker = await workerFor(app);
      let rows = await db.select().from(containers)
        .where(and(eq(containers.applicationId, app.id), eq(containers.state, 'active')))
        .all();
      if (args.container) {
        rows = rows.filter((c) => c.name === args.container);
        if (rows.length === 0) throw new ToolError(`"${app.name}" has no serving container called "${args.container}".`);
      }
      const logs = [];
      for (const row of rows) {
        try {
          const text = await withPodman(worker, (client) =>
            client.getContainerLogs(row.containerId, { stdout: true, stderr: true, tail: args.tail ?? 200, timestamps: true }),
          );
          logs.push({ container: row.name, status: row.status, log: tailChars(text, 50_000) });
        } catch (e: any) {
          logs.push({ container: row.name, status: row.status, log: '', unavailable: e?.message ?? String(e) });
        }
      }
      return { application: { id: app.id, name: app.name }, containers: logs };
    },
  }),
] as const;

type AnyTool = ToolDefinition<z.ZodType>;
const BY_NAME = new Map<string, AnyTool>(TOOLS.map((t) => [t.name, t as unknown as AnyTool]));

/** What `tools/list` returns. */
export function toolList() {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema,
      annotations: { title: t.title, ...t.annotations },
    };
  });
}

export function hasTool(name: string): boolean {
  return BY_NAME.has(name);
}

function text(data: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Run a tool. A bad argument or a refusal comes back as `isError` so the agent
 * can read it and correct itself; anything unexpected is logged and reported
 * the same way, without internals.
 */
export async function callTool(principal: McpPrincipal, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return text({ error: `Invalid arguments: ${z.prettifyError(parsed.error)}` }, true);
  }

  try {
    return text(await tool.run(principal, parsed.data));
  } catch (e) {
    if (e instanceof ToolError) return text({ error: e.message }, true);
    console.error(`[mcp] Tool ${name} failed:`, e);
    return text({ error: `Tool failed: ${(e as Error)?.message ?? String(e)}` }, true);
  }
}

