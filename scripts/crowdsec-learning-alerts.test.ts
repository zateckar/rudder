import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLearningAlerts } from './crowdsec-learning-alerts';

test('looks up exact application request IDs even beyond the newest thousand alerts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rudder-learning-alerts-'));
  const path = join(directory, 'crowdsec.db');
  const db = new Database(path);
  const id = 'rudder-11111111-1111-4111-8111-111111111111';
  const host = 'app.example.test';
  try {
    db.exec(`
      CREATE TABLE alerts (id INTEGER PRIMARY KEY, scenario TEXT, created_at TEXT, kind TEXT);
      CREATE TABLE meta (key TEXT, value TEXT, alert_metas INTEGER);
      CREATE TABLE events (serialized TEXT, alert_events INTEGER);
      CREATE INDEX rudder_learning_request_id ON meta(value, alert_metas) WHERE key='rudder_request_id';
      WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<1200)
      INSERT INTO alerts SELECT n, 'crowdsecurity/test', '2026-11-24T12:00:00Z', 'waf' FROM numbers;
    `);
    const meta = db.query('INSERT INTO meta VALUES (?, ?, ?)');
    const event = db.query('INSERT INTO events VALUES (?, ?)');
    for (const [alert, value, hostname] of [
      [1, id, host], [2, JSON.stringify([id]), host], [3, id + '-suffix', host],
      [4, id, 'other.example.test'], [5, id, host],
    ] as const) {
      meta.run('rudder_request_id', value, alert);
      event.run(JSON.stringify([
        { key: 'target_fqdn', value: hostname },
        { key: 'rule_name', value: 'native_rule:12345', description: 'sensitive' },
        { key: 'data', value: 'sensitive' },
      ]), alert);
    }
    meta.run('rudder_request_id', id, 5);
    const alerts = readLearningAlerts(path, [id], host);
    expect(alerts.map((alert) => alert.id)).toEqual([1, 2]);
    expect(alerts[0].events).toEqual([{ meta: [{ key: 'rule_name', value: 'native_rule:12345' }] }]);
    expect(JSON.stringify(alerts)).not.toContain('sensitive');
  } finally {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
