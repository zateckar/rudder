import { beforeEach, describe, expect, test } from 'bun:test';
import { db, sqlite } from '$lib/db';
import { alertEvents, auditLogs, systemSettings } from '$lib/db/schema';
import { pruneRetainedRecords } from './retention';

/**
 * The two tables nothing ever deleted from.
 *
 * The batching is the part worth testing: it exists so the first sweep after an
 * upgrade does not hold the only thread this process has for the length of a
 * year's backlog, and a loop that stops one batch early leaves rows behind
 * forever — every subsequent run would find the same ones and stop in the same
 * place.
 */

const DAY = 86_400_000;

function insertAuditLogs(count: number, ageDays: number): void {
  const at = Math.floor((Date.now() - ageDays * DAY) / 1000);
  const stmt = sqlite.prepare(
    `INSERT INTO audit_logs (id, action, resource_type, created_at) VALUES (?, 'TEST', 'test', ?)`,
  );
  for (let i = 0; i < count; i++) stmt.run(crypto.randomUUID(), at);
}

function insertAlertEvents(count: number, ageDays: number): void {
  const at = Math.floor((Date.now() - ageDays * DAY) / 1000);
  const stmt = sqlite.prepare(
    `INSERT INTO alert_events (id, resource_type, metric, value, threshold, message, acknowledged, created_at)
     VALUES (?, 'worker', 'cpu_percent', 99, 90, 'test', 0, ?)`,
  );
  for (let i = 0; i < count; i++) stmt.run(crypto.randomUUID(), at);
}

const countOf = (table: string) =>
  (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  sqlite.run('DELETE FROM audit_logs');
  sqlite.run('DELETE FROM alert_events');
  await db.delete(systemSettings);
});

describe('pruneRetainedRecords', () => {
  test('deletes past the retention window and keeps everything inside it', async () => {
    insertAuditLogs(5, 400); // older than the 365-day default
    insertAuditLogs(3, 10);
    insertAlertEvents(4, 200); // older than the 90-day default
    insertAlertEvents(2, 5);

    const result = await pruneRetainedRecords();

    expect(result.auditLogs).toBe(5);
    expect(result.alertEvents).toBe(4);
    expect(countOf('audit_logs')).toBe(3);
    expect(countOf('alert_events')).toBe(2);
  });

  test('clears a backlog larger than one batch', async () => {
    // The batch is 5,000; this needs more than one pass and would leave 2,001
    // rows behind if the loop stopped after the first.
    insertAuditLogs(7_001, 400);

    const result = await pruneRetainedRecords();

    expect(result.auditLogs).toBe(7_001);
    expect(countOf('audit_logs')).toBe(0);
  });

  test('yields between batches rather than running them back to back', async () => {
    insertAuditLogs(6_000, 400);

    // A timer set now must get to run before the sweep finishes. If the batches
    // ran synchronously the whole delete would complete first and this stays
    // false — which is the failure mode the batching exists to prevent.
    let loopRan = false;
    setTimeout(() => { loopRan = true; }, 0);

    await pruneRetainedRecords();

    expect(loopRan).toBe(true);
    expect(countOf('audit_logs')).toBe(0);
  });

  test('honours the configured retention periods', async () => {
    insertAuditLogs(2, 30);
    insertAlertEvents(2, 30);

    await db.insert(systemSettings).values([
      { key: 'audit_log_retention_days', value: '7', updatedAt: new Date() },
      { key: 'alert_event_retention_days', value: '7', updatedAt: new Date() },
    ]);

    const result = await pruneRetainedRecords();

    expect(result.auditLogs).toBe(2);
    expect(result.alertEvents).toBe(2);
  });

  test('an out-of-range setting falls back to the default rather than deleting everything', async () => {
    insertAuditLogs(4, 30);

    await db.insert(systemSettings).values({
      key: 'audit_log_retention_days',
      value: '0',
      updatedAt: new Date(),
    });

    const result = await pruneRetainedRecords();

    // 0 is below the floor, so the 365-day default applies and 30-day-old rows
    // survive. The alternative reading of a bad value — "retain nothing" —
    // would delete the audit trail on a typo.
    expect(result.auditLogs).toBe(0);
    expect(countOf('audit_logs')).toBe(4);
  });

  test('does nothing when there is nothing old enough', async () => {
    insertAuditLogs(3, 1);
    const result = await pruneRetainedRecords();
    expect(result).toEqual({ auditLogs: 0, alertEvents: 0 });
    expect(countOf('audit_logs')).toBe(3);
  });
});
