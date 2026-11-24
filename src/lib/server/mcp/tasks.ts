/**
 * Long-running application operations started over MCP, and their progress.
 *
 * A deploy takes as long as an image pull plus the application's health
 * timeout — minutes, routinely. An MCP tool call that blocked for that long
 * would hit the client's request timeout and leave the agent unable to tell a
 * deploy that failed from one still running. So every operation that changes
 * an application returns a task id at once, runs in the background, and is
 * polled with `get_task`.
 *
 * Held in memory. A task is a handle on work this process is doing; if the
 * process restarts the work stops with it, and the durable record of what
 * happened is the deployment history (`list_deployments`), which startup
 * recovery already reconciles for interrupted deploys. Finished tasks are kept
 * for a day so an agent that polls late still gets an answer.
 */
import { db } from '#lib/db/index.ts';
import { deployments } from '#lib/db/schema.ts';
import { and, desc, eq, gte } from 'drizzle-orm';

export type TaskKind = 'deploy' | 'rollback' | 'start' | 'stop' | 'restart' | 'scale';
export type TaskStatus = 'running' | 'succeeded' | 'failed';

export interface TaskOutcome {
  success: boolean;
  message: string;
  deploymentId?: string;
  details?: Record<string, unknown>;
}

export interface Task {
  id: string;
  kind: TaskKind;
  applicationId: string;
  applicationName: string;
  teamId: string;
  /** Token subject that started it. */
  startedBy: string;
  status: TaskStatus;
  message: string | null;
  deploymentId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
  finishedAt: Date | null;
}

const RETENTION_MS = 24 * 60 * 60_000;
const MAX_TASKS = 2_000;

const tasks = new Map<string, Task>();

function prune(): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, task] of tasks) {
    if (task.finishedAt && task.finishedAt.getTime() < cutoff) tasks.delete(id);
  }
  // Still too many: drop the oldest finished ones. Running tasks are never
  // dropped — they are the ones somebody is waiting on.
  if (tasks.size > MAX_TASKS) {
    const finished = [...tasks.values()]
      .filter((t) => t.finishedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const task of finished.slice(0, tasks.size - MAX_TASKS)) tasks.delete(task.id);
  }
}

/**
 * Start `work` in the background and return its task immediately.
 *
 * `work` never rejects the caller: a throw becomes a failed task carrying the
 * message, because by the time it happens nobody is awaiting the promise.
 */
export function startTask(
  init: Pick<Task, 'kind' | 'applicationId' | 'applicationName' | 'teamId' | 'startedBy'>,
  work: () => Promise<TaskOutcome>,
): Task {
  prune();
  const task: Task = {
    ...init,
    id: crypto.randomUUID(),
    status: 'running',
    message: null,
    deploymentId: null,
    details: null,
    createdAt: new Date(),
    finishedAt: null,
  };
  tasks.set(task.id, task);

  void (async () => {
    try {
      const outcome = await work();
      task.status = outcome.success ? 'succeeded' : 'failed';
      task.message = outcome.message;
      task.deploymentId = outcome.deploymentId ?? task.deploymentId;
      task.details = outcome.details ?? null;
    } catch (e: any) {
      console.error(`[mcp] Task ${task.kind} ${task.applicationName} threw:`, e);
      task.status = 'failed';
      task.message = e?.message ?? String(e);
      task.deploymentId = e?.deploymentId ?? task.deploymentId;
    } finally {
      task.finishedAt = new Date();
    }
  })();

  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function listTasks(filter: { teamIds: ReadonlySet<string>; applicationId?: string }): Task[] {
  return [...tasks.values()]
    .filter((t) => filter.teamIds.has(t.teamId))
    .filter((t) => !filter.applicationId || t.applicationId === filter.applicationId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * The deployment row a deploy-shaped task is producing, while it runs.
 *
 * `executeApplicationDeploy` writes its history row early and updates it as the
 * deploy proceeds, but only reports the id when it returns. Until then, the row
 * is the newest one for the application created since the task started.
 */
export async function deploymentForTask(task: Task) {
  if (task.deploymentId) {
    return db.select().from(deployments).where(eq(deployments.id, task.deploymentId)).get();
  }
  if (task.kind === 'start' || task.kind === 'stop' || task.kind === 'restart') return undefined;
  // Second precision on the column; allow for the row landing in the same second.
  const since = new Date(Math.floor(task.createdAt.getTime() / 1000) * 1000);
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.applicationId, task.applicationId), gte(deployments.createdAt, since)))
    .orderBy(desc(deployments.version))
    .limit(1)
    .get();
}

/** For tests. */
export function clearTasksForTests(): void {
  tasks.clear();
}
