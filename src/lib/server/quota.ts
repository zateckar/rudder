/** Team quotas are checked against the executable plan, under the deploy lock. */
import { db } from '$lib/db';
import { applications, containers, teamQuotas } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { DeploymentPlan } from './deploy/plan';
import { withLock } from './locks';

export interface QuotaVerdict { allowed: boolean; message?: string; }
const OK: QuotaVerdict = { allowed: true };

export function checkApplicationQuota(teamId: string | null): QuotaVerdict {
  if (!teamId) return OK;
  const quota = db.select().from(teamQuotas).where(eq(teamQuotas.teamId, teamId)).get();
  if (!quota || quota.maxApplications === null) return OK;
  const count = db.select({ id: applications.id }).from(applications)
    .where(eq(applications.teamId, teamId)).all().length;
  return count >= quota.maxApplications
    ? { allowed: false, message: `Team quota exceeded: maximum ${quota.maxApplications} applications allowed (currently ${count})` }
    : OK;
}

/** The check and insertion must share one synchronous SQLite transaction. */
export function createApplicationWithQuota(values: typeof applications.$inferInsert): QuotaVerdict {
  return db.transaction(() => {
    const quota = checkApplicationQuota(values.teamId ?? null);
    if (quota.allowed) db.insert(applications).values(values).run();
    return quota;
  });
}

/** A team can deploy onto several workers; their allocations must not overlap. */
export function withTeamDeployQuota<T>(teamId: string | null, callback: () => Promise<T>): Promise<T> {
  return teamId
    ? withLock(`quota:team:${teamId}`, { operation: 'allocate team deployment resources' }, callback)
    : callback();
}

export interface ContainerResources { cpuLimitCores: number | null; memoryLimitBytes: number | null; }
type ResourcePlan = Pick<DeploymentPlan['containers'][number], 'memory' | 'cpuQuota' | 'cpuPeriod'>;
export function plannedResources(container: ResourcePlan): ContainerResources {
  const period = container.cpuPeriod ?? 100_000;
  const cpu = container.cpuQuota;
  return {
    cpuLimitCores: cpu !== undefined && Number.isFinite(cpu) && cpu > 0 && Number.isFinite(period) && period > 0
      ? cpu / period : null,
    memoryLimitBytes: container.memory !== undefined && Number.isFinite(container.memory) && container.memory > 0
      ? container.memory : null,
  };
}

/**
 * Replacement quotas describe the resulting workload. Blue/green may overlap
 * its previous generation during verification; other applications' existing
 * rows remain charged, including retained containers. Missing rows consume none.
 * Unknown legacy limits are unbounded, never zero under a finite resource quota.
 */
export async function checkDeployQuota(teamId: string | null, applicationId: string, plan: { containers: readonly ResourcePlan[] },
  replacement: { containerId?: string; keepInactive?: boolean; keepActive?: boolean } = {}): Promise<QuotaVerdict> {
  if (!teamId) return OK;
  const quota = db.select().from(teamQuotas).where(eq(teamQuotas.teamId, teamId)).get();
  if (!quota) return OK;
  const apps = db.select({ id: applications.id }).from(applications)
    .where(eq(applications.teamId, teamId)).all();
  const rows = apps.length
    ? db.select().from(containers).where(inArray(containers.applicationId, apps.map((app) => app.id))).all()
    : [];
  const present = rows.filter((row) => row.status !== 'missing');
  if (quota.maxApplications !== null && apps.length > quota.maxApplications &&
      !present.some((row) => row.applicationId === applicationId)) {
    return { allowed: false, message: `Team quota exceeded: maximum ${quota.maxApplications} applications allowed (currently ${apps.length})` };
  }
  const existing = present.filter((row) => {
    if (replacement.containerId) return row.id !== replacement.containerId;
    if (row.applicationId !== applicationId) return true;
    return row.state === 'active' ? !!replacement.keepActive : !!replacement.keepInactive;
  });
  const projectedCount = existing.length + plan.containers.length;
  if (quota.maxContainers !== null && projectedCount > quota.maxContainers) {
    return { allowed: false, message: `Team quota exceeded: maximum ${quota.maxContainers} containers allowed (this deploy would bring the team to ${projectedCount})` };
  }
  const resources = [...existing, ...plan.containers.map(plannedResources)];
  for (const [field, limit, label] of [
    ['cpuLimitCores', quota.maxCpuCores, 'CPU cores'],
    ['memoryLimitBytes', quota.maxMemoryBytes, 'memory bytes'],
  ] as const) {
    if (limit === null) continue;
    if (resources.some((resource) => resource[field] === null || !Number.isFinite(resource[field]) || resource[field]! <= 0)) {
      return { allowed: false, message: `Team quota requires explicit finite ${label} limits on every container, including existing applications` };
    }
    const total = resources.reduce((sum, resource) => sum + resource[field]!, 0);
    if (total > limit + (field === 'cpuLimitCores' ? 1e-9 : 0)) {
      return { allowed: false, message: `Team quota exceeded: maximum ${limit} ${label} allowed (this deploy would bring the team to ${total})` };
    }
  }
  return OK;
}
