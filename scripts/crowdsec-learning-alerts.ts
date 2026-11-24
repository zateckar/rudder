import { Database } from 'bun:sqlite';

const requestId = /^rudder-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readLearningAlerts(databasePath: string, ids: string[], hostname: string) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  if (wanted.length > 500 || wanted.some((id) => !requestId.test(id))) {
    throw new Error('Invalid learning request IDs');
  }
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    const alerts = db.query<{
      id: number; scenario: string; created_at: string; value: string; evidence: string;
    }, [string, string]>(`
      WITH wanted AS (SELECT value FROM json_each(?))
      SELECT a.id, a.scenario, a.created_at, m.value,
        (SELECT json_group_array(json_object('key', 'rule_name', 'value', json_extract(item.value, '$.value')))
          FROM events e, json_each(e.serialized) item
          WHERE e.alert_events = a.id AND json_extract(item.value, '$.key') = 'rule_name') AS evidence
      FROM meta m JOIN alerts a ON a.id = m.alert_metas
      WHERE m.key = 'rudder_request_id'
        AND a.kind = 'waf'
        AND m.value IN (SELECT value FROM wanted UNION ALL SELECT json_array(value) FROM wanted)
        AND (SELECT count(*) FROM meta n
          WHERE n.alert_metas = a.id AND n.key = 'rudder_request_id') = 1
        AND EXISTS (SELECT 1 FROM events e, json_each(e.serialized) item
          WHERE e.alert_events = a.id AND json_extract(item.value, '$.key') = 'target_fqdn'
            AND lower(json_extract(item.value, '$.value')) = ?)
      ORDER BY a.id
    `).all(JSON.stringify(wanted), hostname.toLowerCase());
    return alerts.map(({ value, evidence, id, scenario, created_at }) => ({
      id,
      scenario: /^(?:Enabling body inspection|[a-z0-9-]+\/[a-z0-9-]+|native_rule:[0-9]+|anomaly score (?:out-of-band|block): (?:(?:[a-z_]+): [0-9]+, ){1,12})$/.test(scenario)
        ? scenario : 'CrowdSec AppSec alert',
      created_at,
      meta: [{ key: 'rudder_request_id', value }],
      events: [{ meta: JSON.parse(evidence) }],
    }));
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const db = new Database(process.argv[2], { create: false, strict: true });
  try {
    db.exec(`
      PRAGMA busy_timeout = 3000;
      CREATE INDEX IF NOT EXISTS rudder_learning_request_id
        ON meta(value, alert_metas) WHERE key = 'rudder_request_id';
    `);
  } finally {
    db.close();
  }
}
