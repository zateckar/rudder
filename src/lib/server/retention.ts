/**
 * Pruning the two tables that only ever grow.
 *
 * `audit_logs` gains a row for every mutating request and for the reads worth
 * recording; `alert_events` gains one every time a rule fires. Nothing ever
 * deleted from either. They are small today — which is exactly why this is
 * worth doing now rather than at the point where it is urgent, because the way
 * it stops being small is gradual and the way it hurts is not: `bun:sqlite` is
 * synchronous, so the scan that eventually costs a second costs the whole
 * process a second, with every request behind it.
 *
 * The metrics tables already have this (see `pruneOldData`); these two were
 * simply never given it.
 */

import { sqlite } from '$lib/db';
import { getTableName } from 'drizzle-orm';
import { auditLogs, alertEvents } from '$lib/db/schema';
import { numericSetting } from './settings';

/**
 * A year for the audit trail, which is a record of who did what and is the
 * thing anyone asks for after an incident. A quarter for alert history, which
 * is operational noise past the week it happened in.
 */
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
const DEFAULT_ALERT_RETENTION_DAYS = 90;

/** Daily. Nothing here is time-sensitive and every run is a full table scan. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Rows per statement.
 *
 * The point of batching is not the total work, which is the same either way,
 * but the length of the individual stall: one `DELETE` covering a year of
 * backlog on first run holds the only thread the process has for as long as it
 * takes, and every request in flight waits. Five thousand is small enough to be
 * imperceptible and large enough that a year clears in a handful of passes.
 */
const BATCH = 5_000;

/**
 * Delete `table`'s rows older than `cutoff`, a batch at a time.
 *
 * Yields to the event loop between batches. Without that the batching would be
 * decorative — the statements would run back to back in one synchronous run and
 * hold the loop exactly as long as a single large delete.
 */
async function pruneTable(table: string, cutoff: Date): Promise<number> {
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);
  // `id IN (SELECT ... LIMIT)` rather than `DELETE ... LIMIT`, which needs a
  // compile-time option SQLite is not always built with.
  const statement = sqlite.prepare(
    `DELETE FROM ${table} WHERE id IN (
       SELECT id FROM ${table} WHERE created_at < ? ORDER BY created_at LIMIT ${BATCH}
     )`,
  );

  let deleted = 0;
  for (;;) {
    const { changes } = statement.run(cutoffUnix);
    deleted += changes;
    if (changes < BATCH) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return deleted;
}

export async function pruneRetainedRecords(): Promise<{ auditLogs: number; alertEvents: number }> {
  const result = { auditLogs: 0, alertEvents: 0 };

  const auditDays = await numericSetting(
    'audit_log_retention_days',
    DEFAULT_AUDIT_RETENTION_DAYS,
    7,
    3650,
  );
  const alertDays = await numericSetting(
    'alert_event_retention_days',
    DEFAULT_ALERT_RETENTION_DAYS,
    1,
    3650,
  );

  // Table names taken from the schema rather than written out, so a rename
  // reaches the SQL above instead of leaving it to fail at three in the morning.
  try {
    result.auditLogs = await pruneTable(
      getTableName(auditLogs),
      new Date(Date.now() - auditDays * 86_400_000),
    );
  } catch (e) {
    console.error('[retention] Could not prune audit_logs:', (e as any)?.message ?? e);
  }

  try {
    // Acknowledgement is deliberately not consulted. An alert nobody
    // acknowledged in three months is not waiting to be actioned, and keeping
    // it forever on the theory that it might be is how the table becomes the
    // problem this exists to avoid.
    result.alertEvents = await pruneTable(
      getTableName(alertEvents),
      new Date(Date.now() - alertDays * 86_400_000),
    );
  } catch (e) {
    console.error('[retention] Could not prune alert_events:', (e as any)?.message ?? e);
  }

  if (result.auditLogs > 0 || result.alertEvents > 0) {
    console.log(
      `[retention] Pruned ${result.auditLogs} audit log(s) older than ${auditDays} days and ` +
        `${result.alertEvents} alert event(s) older than ${alertDays} days.`,
    );
  }

  return result;
}

async function retentionLoop(): Promise<void> {
  try {
    await pruneRetainedRecords();
  } catch (e) {
    console.error('[retention] Sweep failed:', (e as any)?.message ?? e);
  }
  setTimeout(retentionLoop, SWEEP_INTERVAL_MS).unref?.();
}

export function startRetentionSweep(): void {
  console.log('[retention] Starting daily sweep');
  // A minute in rather than at once: the first sweep after an upgrade may have
  // a year of backlog to clear, and startup already has the migration, the
  // schema check and the deploy recovery to get through.
  setTimeout(retentionLoop, 60_000).unref?.();
}
