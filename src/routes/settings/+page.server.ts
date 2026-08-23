import { db } from '$lib/db';
import { systemSettings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  const currentUser = requirePageAdmin(event).user;

  const intervalRow = await db.select().from(systemSettings).where(eq(systemSettings.key, 'metrics_interval_seconds')).get();
  const metricsInterval = intervalRow ? parseInt(intervalRow.value) : 300;

  const retentionRow = await db.select().from(systemSettings).where(eq(systemSettings.key, 'metrics_retention_days')).get();
  const metricsRetentionDays = retentionRow ? parseInt(retentionRow.value) : 30;

  return {
    user: currentUser,
    metricsInterval,
    metricsRetentionDays,
  };
};
