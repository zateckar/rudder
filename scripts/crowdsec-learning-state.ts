import { Database } from 'bun:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';

export const lifetime = 900;
const retention = 86_400_000;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matches(value: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex'));
}

export function openLearningState(path: string) {
  const db = new Database(path, { strict: true });
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, grant_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      enrolled_at INTEGER, revoked_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, status INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id, at);
  `);

  const active = db.query<{
    id: string; grant_hash: string; code_hash: string; attempts: number;
  }, [number]>(`
    SELECT id, grant_hash, code_hash, attempts FROM sessions
    WHERE expires_at > ? AND enrolled_at IS NULL AND revoked_at IS NULL
  `);
  const current = db.query(`
    SELECT 1 FROM sessions WHERE expires_at > ? AND revoked_at IS NULL LIMIT 1
  `);

  return {
    close: () => db.close(),
    create: db.transaction((id: string, grantHash: string, codeHash: string) => {
      if (!uuid.test(id) || !sha256.test(grantHash) || !sha256.test(codeHash)) {
        throw new Error('Invalid enrollment record');
      }
      const now = Date.now();
      db.run('DELETE FROM sessions WHERE expires_at <= ?', [now - retention]);
      if (current.get(now)) return null;
      const expiresAt = now + lifetime * 1000;
      db.run('INSERT INTO sessions (id, grant_hash, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        [id, grantHash, codeHash, now, expiresAt]);
      return { expiresAt };
    }).immediate,

    redeem: db.transaction((credential: string) => {
      const now = Date.now();
      const session = active.get(now);
      if (!session) return;
      const manual = /^[0-9A-V]{6}$/.test(credential) && session.attempts < 10;
      if (manual) db.run('UPDATE sessions SET attempts = attempts + 1 WHERE id = ?', [session.id]);
      if (!matches(credential, session.grant_hash) && !(manual && matches(credential, session.code_hash))) return;
      const expiresAt = now + lifetime * 1000;
      db.run('UPDATE sessions SET enrolled_at = ?, expires_at = ? WHERE id = ?', [now, expiresAt, session.id]);
      return { id: session.id, expiresAt };
    }).immediate,

    isActive: (id: string, now: number) => !!db.query(`
      SELECT 1 FROM sessions WHERE id = ? AND enrolled_at IS NOT NULL AND expires_at > ? AND revoked_at IS NULL
    `).get(id, now),

    record: (id: string, sessionId: string, at: number, status: number) => db.run(`
      INSERT INTO requests (id, session_id, at, status)
      SELECT ?, id, ?, ? FROM sessions WHERE id = ?
      AND enrolled_at <= ? AND expires_at > ? AND revoked_at IS NULL
      AND (SELECT COUNT(*) FROM requests WHERE session_id = ?) < 500
    `, [id, at, status, sessionId, at, at, sessionId]),

    read: db.transaction((id: string) => {
      const session = db.query<{
        id: string; enrolledAt: number | null; expiresAt: number; revokedAt: number | null;
      }, [string, number]>(`
        SELECT id, enrolled_at AS enrolledAt, expires_at AS expiresAt, revoked_at AS revokedAt
        FROM sessions WHERE id = ? AND expires_at > ?
      `).get(id, Date.now() - retention);
      if (!session) return null;
      const requests = db.query<{ id: string; at: number; status: number }, [string]>(`
        SELECT id, at, status FROM requests WHERE session_id = ? ORDER BY at, id
      `).all(id);
      return { ...session, requests };
    }),

    latest: () => db.query<{ id: string }, [number]>(`
      SELECT id FROM sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1
    `).get(Date.now() - retention)?.id ?? null,

    revoke: (id: string) => db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [Date.now(), id]).changes > 0,
  };
}
