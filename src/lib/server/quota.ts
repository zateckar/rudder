/**
 * Team resource quota enforcement.
 *
 * Shared by the UI deploy endpoint and the Kubernetes-compatible API so both
 * entry points are held to the same limits — the k8s path previously created
 * and deployed applications without consulting quotas at all.
 */
import { db } from '$lib/db';
import { applications, containers, teamQuotas } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

export interface QuotaVerdict {
  allowed: boolean;
  /** Human-readable reason, present when `allowed` is false. */
  message?: string;
}

const OK: QuotaVerdict = { allowed: true };

/** Count containers belonging to a set of applications. */
async function countContainers(appIds: string[]): Promise<number> {
  if (appIds.length === 0) return 0;
  const rows = await db
    .select({ id: containers.id })
    .from(containers)
    .where(inArray(containers.applicationId, appIds))
    .all();
  return rows.length;
}

/**
 * Check whether a team may create one more application.
 * Call before inserting a new application row.
 */
export async function checkApplicationQuota(teamId: string | null): Promise<QuotaVerdict> {
  if (!teamId) return OK;

  const quota = await db.select().from(teamQuotas).where(eq(teamQuotas.teamId, teamId)).get();
  if (!quota || quota.maxApplications === null) return OK;

  const teamApps = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.teamId, teamId))
    .all();

  if (teamApps.length >= quota.maxApplications) {
    return {
      allowed: false,
      message:
        `Team quota exceeded: maximum ${quota.maxApplications} applications allowed ` +
        `(currently ${teamApps.length})`,
    };
  }

  return OK;
}

/**
 * Check whether an application may be deployed under its team's quota.
 * Accounts for the replicas this deploy will create.
 */
export async function checkDeployQuota(
  teamId: string | null,
  applicationId: string,
  replicas = 1,
): Promise<QuotaVerdict> {
  if (!teamId) return OK;

  const quota = await db.select().from(teamQuotas).where(eq(teamQuotas.teamId, teamId)).get();
  if (!quota) return OK;

  const teamApps = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.teamId, teamId))
    .all();
  const teamAppIds = teamApps.map((a) => a.id);

  if (quota.maxApplications !== null) {
    const existing = await db
      .select({ id: containers.id })
      .from(containers)
      .where(eq(containers.applicationId, applicationId))
      .all();

    // Only gate the first deploy: an app already running should stay
    // redeployable even if the limit was lowered afterwards.
    if (existing.length === 0 && teamApps.length > quota.maxApplications) {
      return {
        allowed: false,
        message:
          `Team quota exceeded: maximum ${quota.maxApplications} applications allowed ` +
          `(currently ${teamApps.length})`,
      };
    }
  }

  if (quota.maxContainers !== null) {
    const currentTotal = await countContainers(teamAppIds);
    const thisApp = await db
      .select({ id: containers.id })
      .from(containers)
      .where(eq(containers.applicationId, applicationId))
      .all();

    // Redeploy replaces this application's containers, so its current count is
    // released before the new replicas are created.
    const projected = currentTotal - thisApp.length + Math.max(1, replicas);

    if (projected > quota.maxContainers) {
      return {
        allowed: false,
        message:
          `Team quota exceeded: maximum ${quota.maxContainers} containers allowed ` +
          `(this deploy would bring the team to ${projected})`,
      };
    }
  }

  return OK;
}
