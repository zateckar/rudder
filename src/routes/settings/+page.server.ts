import { db } from '$lib/db';
import { systemSettings } from '$lib/db/schema';
import { inArray } from 'drizzle-orm';
import { requirePageAdmin } from '$lib/server/auth';

/**
 * Each setting and what the code that reads it falls back to when the row is
 * absent.
 *
 * These defaults must agree with the ones in $lib/server/metrics,
 * $lib/server/alerts and $lib/server/retention. Showing a different number here
 * would tell an operator the panel runs on a cadence it does not — the control
 * is the only place most of these are ever seen.
 */
const SETTINGS = {
  metrics_interval_seconds: 300,
  metrics_retention_days: 30,
  alert_interval_seconds: 60,
  audit_log_retention_days: 365,
  alert_event_retention_days: 90,
} as const;

export const load = async (event: { locals: App.Locals }) => {
  const currentUser = requirePageAdmin(event).user;

  // One query. This was five sequential single-row reads at three, and the page
  // was about to make it five.
  const rows = await db
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, Object.keys(SETTINGS)))
    .all();
  const stored = new Map(rows.map((r) => [r.key, parseInt(r.value)]));

  const value = (key: keyof typeof SETTINGS) => {
    const parsed = stored.get(key);
    return parsed === undefined || Number.isNaN(parsed) ? SETTINGS[key] : parsed;
  };

  return {
    user: currentUser,
    metricsInterval: value('metrics_interval_seconds'),
    metricsRetentionDays: value('metrics_retention_days'),
    alertInterval: value('alert_interval_seconds'),
    auditLogRetentionDays: value('audit_log_retention_days'),
    alertEventRetentionDays: value('alert_event_retention_days'),
  };
};
