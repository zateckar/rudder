/**
 * Alert evaluation engine.
 * Checks all enabled alert rules against latest metrics and fires notifications.
 */

import { db } from '$lib/db';
import {
  alertRules,
  alertEvents,
  notificationChannels,
  workerMetrics,
  containerMetrics,
} from '$lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { sendNotification } from './notifications';
import { numericSetting } from './settings';

/** Deduplication window: don't re-trigger the same rule within this period */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Evaluate all enabled alert rules.
 * For each rule, check the latest metric value and fire an alert event + notification if threshold is exceeded.
 */
export async function evaluateAlerts(): Promise<void> {
  let rules;
  try {
    rules = await db.select().from(alertRules).where(eq(alertRules.enabled, true)).all();
  } catch (e) {
    console.error('[alerts] Failed to load alert rules:', e);
    return;
  }

  if (rules.length === 0) return;

  for (const rule of rules) {
    try {
      await evaluateRule(rule);
    } catch (e) {
      console.error(`[alerts] Error evaluating rule "${rule.name}" (${rule.id}):`, e);
    }
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────
//
// Alerting used to be the last statement of the metrics collection cycle, so
// `metrics_interval_seconds` silently doubled as the alerting interval. An
// operator raising it to an hour — a reasonable thing to do to a fleet whose
// graphs they read once a day — got alerts up to an hour late, with nothing in
// the settings page saying so. Reconciliation is still a passenger on that
// loop, because it reuses the container listing the sweep has just fetched;
// this is not, because it only reads metrics rows the collector has already
// written, so its own timer costs nothing but a database read.
//
// Evaluating more often than metrics are collected is harmless: a rule that has
// fired is suppressed for DEDUP_WINDOW_MS, and re-reading the same latest row
// reaches the same verdict.

const DEFAULT_ALERT_INTERVAL_SECONDS = 60;

async function alertLoop(): Promise<void> {
  try {
    await evaluateAlerts();
  } catch (e) {
    console.error('[alerts] Evaluation cycle failed:', (e as any)?.message ?? e);
  }
  // Re-read every cycle so a change in the settings page takes effect without a
  // restart, and scheduled from the end of the run so a slow cycle cannot
  // overlap the next one.
  const seconds = await numericSetting(
    'alert_interval_seconds',
    DEFAULT_ALERT_INTERVAL_SECONDS,
    10,
    3600,
  ).catch(() => DEFAULT_ALERT_INTERVAL_SECONDS);
  setTimeout(alertLoop, seconds * 1000).unref?.();
}

export function startAlertEvaluation(): void {
  console.log('[alerts] Starting rule evaluation');
  // Same delay as the metrics collector: let database initialization finish,
  // and let the first collection put something there to evaluate.
  setTimeout(alertLoop, 10_000).unref?.();
}

type AlertRule = typeof alertRules.$inferSelect;

async function evaluateRule(rule: AlertRule): Promise<void> {
  // Deduplication: skip if triggered recently
  if (rule.lastTriggeredAt) {
    const lastTriggered = rule.lastTriggeredAt instanceof Date
      ? rule.lastTriggeredAt.getTime()
      : new Date(rule.lastTriggeredAt as any).getTime();
    if (Date.now() - lastTriggered < DEDUP_WINDOW_MS) {
      return;
    }
  }

  // Get the latest metric value based on resource type
  const metricValue = await getLatestMetricValue(rule);
  if (metricValue === null) return; // No metric data available

  // Check if threshold is exceeded
  const exceeded = checkThreshold(metricValue, rule.operator, rule.threshold);
  if (!exceeded) return;

  // Threshold exceeded — create alert event
  const message = buildAlertMessage(rule, metricValue);
  const severity = getSeverity(rule, metricValue);

  const eventId = crypto.randomUUID();
  const now = new Date();

  await db.insert(alertEvents).values({
    id: eventId,
    ruleId: rule.id,
    resourceType: rule.resourceType,
    resourceId: rule.resourceId,
    metric: rule.metric,
    value: metricValue,
    threshold: rule.threshold,
    message,
    acknowledged: false,
    createdAt: now,
  });

  // Update lastTriggeredAt on the rule
  await db.update(alertRules)
    .set({ lastTriggeredAt: now })
    .where(eq(alertRules.id, rule.id));

  console.log(`[alerts] Rule "${rule.name}" triggered: ${message}`);

  // Send notification through the linked channel
  if (rule.channelId) {
    const channel = await db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, rule.channelId))
      .get();

    if (channel) {
      await sendNotification(channel, {
        title: `Alert: ${rule.name}`,
        message,
        severity,
      });
    } else {
      console.warn(`[alerts] Channel ${rule.channelId} not found for rule "${rule.name}"`);
    }
  }
}

async function getLatestMetricValue(rule: AlertRule): Promise<number | null> {
  const metric = rule.metric;

  if (rule.resourceType === 'worker') {
    const query = rule.resourceId
      ? db.select().from(workerMetrics)
          .where(eq(workerMetrics.workerId, rule.resourceId))
          .orderBy(desc(workerMetrics.collectedAt))
          .limit(1)
      : db.select().from(workerMetrics)
          .orderBy(desc(workerMetrics.collectedAt))
          .limit(1);

    const row = await query.get();
    if (!row) return null;

    return extractWorkerMetric(row, metric);
  }

  if (rule.resourceType === 'container') {
    const query = rule.resourceId
      ? db.select().from(containerMetrics)
          .where(eq(containerMetrics.containerId, rule.resourceId))
          .orderBy(desc(containerMetrics.collectedAt))
          .limit(1)
      : db.select().from(containerMetrics)
          .orderBy(desc(containerMetrics.collectedAt))
          .limit(1);

    const row = await query.get();
    if (!row) return null;

    return extractContainerMetric(row, metric);
  }

  // Application type — check container metrics for containers linked to this application
  // For now, treat application alerts as container-level (aggregate not needed for MVP)
  if (rule.resourceType === 'application') {
    const query = db.select().from(containerMetrics)
      .orderBy(desc(containerMetrics.collectedAt))
      .limit(1);

    const row = await query.get();
    if (!row) return null;

    return extractContainerMetric(row, metric);
  }

  return null;
}

function extractWorkerMetric(row: typeof workerMetrics.$inferSelect, metric: string): number | null {
  switch (metric) {
    case 'cpu_percent': return row.cpuPercent ?? null;
    case 'mem_percent': return row.memPercent ?? null;
    case 'disk_percent': return row.diskPercent ?? null;
    case 'mem_usage_bytes': return row.memUsageBytes ?? null;
    case 'disk_usage_bytes': return row.diskUsageBytes ?? null;
    case 'containers_running': return row.containersRunning ?? null;
    case 'containers_total': return row.containersTotal ?? null;
    // Patch state. Null when the worker never reported it — returning 0 would
    // read as "fully patched" and silence a rule for a host nobody scanned.
    case 'updates_pending': return row.updatesPending ?? null;
    case 'updates_security': return row.updatesSecurity ?? null;
    case 'reboot_required': return row.rebootRequired ?? null;
    default: return null;
  }
}

function extractContainerMetric(row: typeof containerMetrics.$inferSelect, metric: string): number | null {
  switch (metric) {
    case 'cpu_percent': return row.cpuPercent ?? null;
    case 'mem_percent': return row.memPercent ?? null;
    case 'mem_usage_bytes': return row.memUsageBytes ?? null;
    case 'net_rx_bytes': return row.netRxBytes ?? null;
    case 'net_tx_bytes': return row.netTxBytes ?? null;
    default: return null;
  }
}

function checkThreshold(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case 'gt': return value > threshold;
    case 'lt': return value < threshold;
    case 'gte': return value >= threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    default: return false;
  }
}

function buildAlertMessage(rule: AlertRule, value: number): string {
  const operatorSymbol: Record<string, string> = {
    gt: '>',
    lt: '<',
    gte: '>=',
    lte: '<=',
    eq: '==',
  };
  const op = operatorSymbol[rule.operator] || rule.operator;
  const resource = rule.resourceId
    ? `${rule.resourceType} ${rule.resourceId}`
    : `all ${rule.resourceType}s`;

  return `${rule.name}: ${rule.metric} is ${value} (${op} ${rule.threshold}) on ${resource}`;
}

function getSeverity(rule: AlertRule, value: number): 'info' | 'warning' | 'critical' {
  // Simple heuristic: if value exceeds threshold by > 50%, critical; > 20%, warning; else info
  if (rule.threshold === 0) return 'critical';
  const ratio = Math.abs(value / rule.threshold);
  if (ratio >= 1.5) return 'critical';
  if (ratio >= 1.2) return 'warning';
  return 'info';
}
