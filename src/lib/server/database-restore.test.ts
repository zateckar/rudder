import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { applyPendingDatabaseRestore, stageDatabaseRestore } from './database-restore';
import { resolveMigrationsDir } from './paths';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rudder-restore-'));
  directories.push(directory);
  const path = join(directory, 'live.db');
  const live = new Database(path);
  live.run('PRAGMA journal_mode=WAL');
  live.run('PRAGMA wal_autocheckpoint=0');
  migrate(drizzle(live), { migrationsFolder: resolveMigrationsDir() });
  live.run("INSERT INTO teams (id,name,slug,created_at,updated_at) VALUES ('backup','backup','backup',0,0)");
  const snapshot = join(directory, 'snapshot.db');
  live.run('VACUUM INTO ?', [snapshot]);
  live.run("INSERT INTO teams (id,name,slug,created_at,updated_at) VALUES ('latest','latest','latest',0,0)");
  return { path, live, bytes: readFileSync(snapshot) };
}

function ids(path: string) {
  const db = new Database(path, { readonly: true });
  try { return db.query('SELECT id FROM teams ORDER BY id').all(); }
  finally { db.close(true); }
}

describe('staged database restoration', () => {
  test('leaves the open database and committed writes untouched until startup', () => {
    const { path, live, bytes } = fixture();
    try {
      stageDatabaseRestore(path, bytes);
      expect(live.query('SELECT count(*) AS n FROM teams').get()).toEqual({ n: 2 });
      live.run("INSERT INTO teams (id,name,slug,created_at,updated_at) VALUES ('after-staging','after-staging','after-staging',0,0)");
    } finally { live.close(true); }
    expect(applyPendingDatabaseRestore(path)).toBe(true);
    expect(ids(path)).toEqual([{ id: 'backup' }]);
    expect(ids(`${path}.pre-restore`)).toEqual([{ id: 'after-staging' }, { id: 'backup' }, { id: 'latest' }]);
    expect(applyPendingDatabaseRestore(path)).toBe(false);
  });

  test('recovery snapshot includes transactions left in WAL by an interrupted process', () => {
    const { path, live, bytes } = fixture();
    const interrupted = join(dirname(path), 'interrupted.db');
    try {
      expect(existsSync(`${path}-wal`)).toBe(true);
      copyFileSync(path, interrupted);
      copyFileSync(`${path}-wal`, `${interrupted}-wal`);
    } finally { live.close(true); }
    stageDatabaseRestore(interrupted, bytes);
    expect(applyPendingDatabaseRestore(interrupted)).toBe(true);
    expect(ids(interrupted)).toEqual([{ id: 'backup' }]);
    expect(ids(`${interrupted}.pre-restore`)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
  });

  test('rejects an error document, truncated SQLite, and an unrelated SQLite database', () => {
    const { path, live } = fixture();
    live.close(true);
    for (const bytes of [Buffer.from('<Error>Forbidden</Error>'), Buffer.from('SQLite format 3\0')]) {
      expect(() => stageDatabaseRestore(path, bytes)).toThrow();
      expect(existsSync(`${path}.restore-pending.json`)).toBe(false);
      expect(ids(path)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
    }
    const unrelated = join(dirname(path), 'unrelated.db');
    const db = new Database(unrelated); db.run('CREATE TABLE unrelated (id TEXT)'); db.close(true);
    expect(() => stageDatabaseRestore(path, readFileSync(unrelated))).toThrow('missing Rudder tables');
  });

  test('does not overwrite a pending restore with a second request', () => {
    const { path, live, bytes } = fixture(); live.close(true);
    stageDatabaseRestore(path, bytes);
    const marker = readFileSync(`${path}.restore-pending.json`, 'utf8');
    expect(() => stageDatabaseRestore(path, bytes)).toThrow('already pending');
    expect(readFileSync(`${path}.restore-pending.json`, 'utf8')).toBe(marker);
    expect(applyPendingDatabaseRestore(path)).toBe(true);
  });

  test('rejects a database with core table names but incompatible columns', () => {
    const { path, live } = fixture(); live.close(true);
    const unrelated = join(dirname(path), 'bad-layout.db');
    const db = new Database(unrelated);
    for (const table of ['users', 'teams', 'applications', 'workers']) db.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    db.close(true);
    expect(() => stageDatabaseRestore(path, readFileSync(unrelated))).toThrow();
    expect(existsSync(`${path}.restore-pending.json`)).toBe(false);
    expect(ids(path)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
  });

  test('fails closed if the staged database is changed or disappears', () => {
    const { path, live, bytes } = fixture(); live.close(true);
    stageDatabaseRestore(path, bytes);
    const journal = JSON.parse(readFileSync(`${path}.restore-pending.json`, 'utf8'));
    const candidate = join(dirname(path), journal.candidate);
    writeFileSync(candidate, 'modified');
    expect(() => applyPendingDatabaseRestore(path)).toThrow('changed after validation');
    expect(ids(path)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
    rmSync(candidate);
    expect(() => applyPendingDatabaseRestore(path)).toThrow('replacement cannot be verified');
  });

  test('resumes prepared replacement without overwriting its recovery snapshot', () => {
    const { path, live, bytes } = fixture(); live.close(true);
    stageDatabaseRestore(path, bytes);
    copyFileSync(path, `${path}.pre-restore`);
    const marker = `${path}.restore-pending.json`;
    const journal = JSON.parse(readFileSync(marker, 'utf8')); journal.phase = 'prepared';
    writeFileSync(marker, JSON.stringify(journal));
    expect(applyPendingDatabaseRestore(path)).toBe(true);
    expect(ids(path)).toEqual([{ id: 'backup' }]);
    expect(ids(`${path}.pre-restore`)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
  });

  test('recognizes a committed rename interrupted before journal cleanup', () => {
    const { path, live, bytes } = fixture(); live.close(true);
    stageDatabaseRestore(path, bytes);
    copyFileSync(path, `${path}.pre-restore`);
    const marker = `${path}.restore-pending.json`;
    const journal = JSON.parse(readFileSync(marker, 'utf8')); journal.phase = 'prepared';
    writeFileSync(marker, JSON.stringify(journal));
    renameSync(join(dirname(path), journal.candidate), path);
    expect(applyPendingDatabaseRestore(path)).toBe(true);
    expect(ids(`${path}.pre-restore`)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
    expect(existsSync(marker)).toBe(false);
  });

  test('rejects journal paths outside the database directory', () => {
    const { path, live, bytes } = fixture(); live.close(true);
    stageDatabaseRestore(path, bytes);
    const marker = `${path}.restore-pending.json`;
    const journal = JSON.parse(readFileSync(marker, 'utf8'));
    journal.candidate = `${basename(path)}.restore-../../other.db`;
    writeFileSync(marker, JSON.stringify(journal));
    expect(() => applyPendingDatabaseRestore(path)).toThrow('Invalid database restore journal');
    expect(ids(path)).toEqual([{ id: 'backup' }, { id: 'latest' }]);
  });
});
