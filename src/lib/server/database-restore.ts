import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema';
import { resolveMigrationsDir } from './paths';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

interface RestoreJournal {
  version: 1;
  candidate: string;
  sha256: string;
  phase: 'staged' | 'prepared';
}

const REQUIRED_TABLES = ['users', 'teams', 'applications', 'workers'];
const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const journalPath = (dbPath: string) => `${dbPath}.restore-pending.json`;
export const hasPendingDatabaseRestore = (dbPath: string): boolean => existsSync(journalPath(dbPath));
const checksum = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function syncDirectory(path: string): void {
  // Windows does not expose directory fsync through Node's filesystem API.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurably(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}

function saveJournal(dbPath: string, journal: RestoreJournal): void {
  const path = journalPath(dbPath);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeDurably(temporary, JSON.stringify(journal));
    renameSync(temporary, path);
    syncDirectory(dirname(dbPath));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Opens a standalone snapshot read-only, before any live file is touched. */
export function validateRestoreDatabase(path: string, requireCurrentSchema = true): void {
  const header = readFileSync(path).subarray(0, MAGIC.length);
  if (!header.equals(MAGIC)) throw new Error('Backup is not a SQLite database (wrong header)');
  const candidate = new Database(path, { readonly: true, create: false });
  try {
    const result = candidate.query('PRAGMA integrity_check').all() as Record<string, unknown>[];
    if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') {
      throw new Error('Backup failed SQLite integrity checking');
    }
    const tables = new Set(
      (candidate.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`Backup is missing Rudder tables: ${missing.join(', ')}`);
    if (requireCurrentSchema) {
      for (const table of Object.values(schema)) {
        if (!is(table, SQLiteTable)) continue;
        const name = getTableName(table);
        const present = new Set((candidate.query(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((row) => row.name));
        const absent = Object.values(getTableColumns(table)).filter((column) => !present.has(column.name));
        if (absent.length) throw new Error(`Backup has an incompatible schema: missing ${name}.${absent[0].name}`);
      }
    }
  } finally { candidate.close(true); }
}

/** Upgrade only the isolated candidate; malformed existing tables cannot pass. */
function prepareRestoreDatabase(path: string): void {
  validateRestoreDatabase(path, false);
  const candidate = new Database(path, { readwrite: true, create: false });
  try {
    candidate.run('PRAGMA journal_mode = DELETE');
    migrate(drizzle(candidate, { schema }), { migrationsFolder: resolveMigrationsDir() });
  } finally { candidate.close(true); }
  validateRestoreDatabase(path);
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Publish one validated pending restore. The live connection and WAL are untouched. */
export function stageDatabaseRestore(dbPath: string, bytes: Uint8Array): void {
  if (existsSync(journalPath(dbPath))) {
    throw new Error('A database restore is already pending. Restart the server to apply it first.');
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const candidate = `${basename(dbPath)}.restore-${randomUUID()}.db`;
  const path = join(dirname(dbPath), candidate);
  let published = false;
  try {
    writeDurably(path, bytes);
    prepareRestoreDatabase(path);
    saveJournal(dbPath, { version: 1, candidate, sha256: checksum(path), phase: 'staged' });
    published = true;
  } finally {
    // Once the journal exists startup owns this file, including when a final
    // directory sync failed. Removing it would leave an unrecoverable journal.
    if (!published && !existsSync(journalPath(dbPath)) && existsSync(path)) unlinkSync(path);
  }
}

function readJournal(dbPath: string): RestoreJournal {
  const value = JSON.parse(readFileSync(journalPath(dbPath), 'utf8')) as RestoreJournal;
  const prefix = `${basename(dbPath)}.restore-`;
  if (value.version !== 1 || typeof value.candidate !== 'string' ||
      !value.candidate.startsWith(prefix) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/.test(value.candidate.slice(prefix.length)) ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      (value.phase !== 'staged' && value.phase !== 'prepared')) {
    throw new Error('Invalid database restore journal. Refusing to replace the database.');
  }
  return value;
}

/**
 * Startup-only: call before the application's SQLite connection is opened.
 * The journal makes replacement resumable across interruption at any rename.
 */
export function applyPendingDatabaseRestore(dbPath: string): boolean {
  const marker = journalPath(dbPath);
  if (!existsSync(marker)) return false;
  const journal = readJournal(dbPath);
  const path = join(dirname(dbPath), journal.candidate);
  const recovery = `${dbPath}.pre-restore`;

  if (!existsSync(path)) {
    // An atomic rename completed, but the process stopped before removing the
    // marker. Never apply it again or replace the recovery snapshot in this case.
    if (journal.phase !== 'prepared' || !existsSync(dbPath) || checksum(dbPath) !== journal.sha256) {
      throw new Error('Pending restore file is missing and replacement cannot be verified.');
    }
    validateRestoreDatabase(dbPath, false);
    validateRestoreDatabase(recovery, false);
    unlinkSync(marker);
    syncDirectory(dirname(dbPath));
    return true;
  }

  if (checksum(path) !== journal.sha256) throw new Error('Pending restore file changed after validation.');
  // A new application version may have shipped between staging and restart.
  // Recheck its migrations on the candidate, before altering the live file.
  prepareRestoreDatabase(path);
  const preparedHash = checksum(path);
  if (preparedHash !== journal.sha256) {
    journal.sha256 = preparedHash;
    saveJournal(dbPath, journal);
  }

  if (journal.phase === 'staged') {
    if (!existsSync(dbPath)) throw new Error('Cannot preserve the current database: it is missing.');
    const previous = `${recovery}.${randomUUID()}.tmp`;
    // VACUUM reads committed WAL transactions too. Closing this temporary
    // connection before replacement also finishes SQLite's normal checkpoint.
    try {
      const current = new Database(dbPath, { readwrite: true, create: false });
      try { current.run('VACUUM INTO ?', [previous]); }
      finally { current.close(true); }
      validateRestoreDatabase(previous, false);
      const fd = openSync(previous, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(previous, recovery);
      syncDirectory(dirname(dbPath));
    } finally { if (existsSync(previous)) unlinkSync(previous); }
    journal.phase = 'prepared';
    saveJournal(dbPath, journal);
  } else {
    // The previous process already saved the recovery snapshot. Overwriting
    // it during retry could lose the only complete pre-restore state.
    validateRestoreDatabase(recovery, false);
  }

  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  renameSync(path, dbPath);
  syncDirectory(dirname(dbPath));
  unlinkSync(marker);
  syncDirectory(dirname(dbPath));
  return true;
}
