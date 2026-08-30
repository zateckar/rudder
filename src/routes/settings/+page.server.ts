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

  // Must agree with DEFAULT_ALERT_INTERVAL_SECONDS in $lib/server/alerts — the
  // scheduler falls back to that when the row is absent, and showing a different
  // number here would tell an operator alerting runs on a cadence it does not.
  const alertIntervalRow = await db.select().from(systemSettings).where(eq(systemSettings.key, 'alert_interval_seconds')).get();
  const alertInterval = alertIntervalRow ? parseInt(alertIntervalRow.value) : 60;

  return {
    user: currentUser,
    metricsInterval,
    metricsRetentionDays,
    alertInterval,
  };
};
