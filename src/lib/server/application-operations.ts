/** Durable application operations shared by HTTP, webhooks and MCP. */
import { db } from '#lib/db/index.ts';
import { applicationOperations as operations, applications, deployments } from '#lib/db/schema.ts';
import type { OperationStage, ReportOperationProgress } from '#lib/application-operations.ts';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm';

export type Task = typeof operations.$inferSelect;
export type TaskKind = Task['kind'];
export type TaskInit = Pick<Task, 'kind' | 'applicationId' | 'applicationName' | 'teamId' | 'startedBy'>;

export interface TaskOutcome {
  success: boolean;
  message: string;
  statusCode?: number;
  deploymentId?: string;
  details?: Record<string, unknown>;
}

export type TaskWork = (report: ReportOperationProgress) => Promise<TaskOutcome>;

const RETENTION_MS = 24 * 60 * 60_000;
const MAX_TASKS = 2000;

export class OperationBusy extends Error {
  constructor(readonly task: Task) {
    super(`A ${task.kind} of "${task.applicationName}" is already running (task ${task.id}).`);
  }
}

export function activeTask(applicationId: string): Task | undefined {
  return db.select().from(operations)
    .where(and(eq(operations.applicationId, applicationId), eq(operations.status, 'running'))).get();
}

function prune(now: Date) {
  db.delete(operations).where(lt(operations.finishedAt, new Date(now.getTime() - RETENTION_MS))).run();
  const newest = db.select({ id: operations.id }).from(operations)
    .where(isNotNull(operations.finishedAt))
    .orderBy(desc(operations.createdAt), desc(operations.id)).limit(MAX_TASKS);
  db.delete(operations).where(and(isNotNull(operations.finishedAt), notInArray(operations.id, newest))).run();
}

/** Register before dispatching. Synchronous SQLite access keeps the per-app check and insert together. */
export function launchTask(init: TaskInit, work: TaskWork) {
  const now = new Date();
  const task = db.transaction(() => {
    const busy = activeTask(init.applicationId);
    if (busy) throw new OperationBusy(busy);
    prune(now);
    return db.insert(operations).values({
      ...init, id: crypto.randomUUID(), status: 'running', stage: 'preparing', createdAt: now, updatedAt: now,
    }).returning().get();
  });
  const report: ReportOperationProgress = (stage: OperationStage, deploymentId) => {
    try {
      db.update(operations).set({ stage, deploymentId, updatedAt: new Date() })
        .where(eq(operations.id, task.id)).run();
    } catch (error) {
      // Progress bookkeeping must never interrupt routing or rollback.
      console.error('[operations] Could not record progress:', error);
    }
  };

  const completion = Promise.resolve().then(async () => {
    let outcome: TaskOutcome;
    try {
      outcome = await work(report);
    } catch (error) {
      const failure = error as { message?: string; deploymentId?: string };
      console.error('[operations] Application operation failed:', error);
      outcome = { success: false, message: failure?.message ?? String(error), deploymentId: failure?.deploymentId };
    }
    const finishedAt = new Date();
    try {
      db.update(operations).set({
        status: outcome.success ? 'succeeded' : 'failed',
        message: outcome.message,
        deploymentId: outcome.deploymentId,
        details: outcome.details ?? null,
        updatedAt: finishedAt,
        finishedAt,
      }).where(eq(operations.id, task.id)).run();
    } catch (error) {
      console.error('[operations] Could not record completion:', error);
    }
    return outcome;
  });
  return { task, completion };
}

export function startTask(init: TaskInit, work: TaskWork): Task {
  return launchTask(init, work).task;
}

export function applicationTask(app: { id: string; name: string; teamId: string | null }, kind: TaskKind, startedBy: string): TaskInit {
  return { kind, applicationId: app.id, applicationName: app.name, teamId: app.teamId, startedBy };
}

const visibleTasks = () => or(isNull(operations.finishedAt), gte(operations.finishedAt, new Date(Date.now() - RETENTION_MS)));

export function getTask(id: string): Task | undefined {
  return db.select().from(operations).where(and(eq(operations.id, id), visibleTasks())).get();
}

export function latestTask(applicationId: string): Task | undefined {
  return activeTask(applicationId) ?? db.select().from(operations)
    .where(and(eq(operations.applicationId, applicationId), visibleTasks()))
    .orderBy(desc(operations.createdAt)).get();
}

export function listTasks(filter: { teamIds: ReadonlySet<string>; applicationId?: string; limit?: number }): Task[] {
  if (!filter.teamIds.size) return [];
  return db.select({ task: operations }).from(operations)
    .innerJoin(applications, eq(applications.id, operations.applicationId))
    .where(and(
      inArray(applications.teamId, [...filter.teamIds]),
      eq(applications.teamId, operations.teamId),
      filter.applicationId ? eq(operations.applicationId, filter.applicationId) : undefined,
      visibleTasks(),
    ))
    .orderBy(desc(operations.createdAt)).limit(filter.limit ?? 100).all().map(({ task }) => task);
}

export function deploymentForTask(task: Task) {
  if (!task.deploymentId) return undefined;
  return db.select().from(deployments)
    .where(and(eq(deployments.id, task.deploymentId), eq(deployments.applicationId, task.applicationId))).get();
}

/** Startup only, after interrupted deployment history has been reconciled. */
export function recoverApplicationOperations() {
  const stranded = db.select().from(operations).where(eq(operations.status, 'running')).all();
  const now = new Date();
  db.transaction(() => {
    for (const task of stranded) {
      const deployment = deploymentForTask(task);
      const succeeded = deployment?.status === 'succeeded' || (task.kind === 'rollback' && deployment?.status === 'rolled_back');
      const message = succeeded ? 'Deployment completed before Rudder restarted.'
        : deployment?.errorMessage ?? 'Rudder restarted while this operation was running. Check application health and deployment history before retrying.';
      db.update(operations).set({
        status: succeeded ? 'succeeded' : 'failed', message, updatedAt: now, finishedAt: now,
      }).where(and(eq(operations.id, task.id), eq(operations.status, 'running'))).run();
    }
    prune(now);
  });
}

export function operationView(task: Task) {
  return {
    id: task.id, kind: task.kind, status: task.status, stage: task.stage, message: task.message,
    deploymentId: task.deploymentId, startedAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
  };
}

export function clearTasksForTests(): void {
  db.delete(operations).run();
}
