import { db, sqlite } from '$lib/db';
import { backupConfig } from '$lib/db/schema';
import { decrypt } from '$lib/server/encryption';
import { createHmac } from 'crypto';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveDbPath } from './paths';

/**
 * The database this backs up, and the scratch directory it stages through.
 *
 * Resolved the same way `$lib/db` resolves the file it opens — `DATABASE_URL`
 * first, the directory beside the bundle as a fallback. These used to be
 * `join(__dirname, '../../../data/rudder.db')` outright, which ignored
 * `DATABASE_URL` entirely: on any deployment that pointed it somewhere else,
 * `performBackup` uploaded a file nothing writes to (or failed to copy at all)
 * and `restoreBackup` wrote the downloaded database to a path nothing reads —
 * and then reported success, so the failure only surfaced after a restart, when
 * the data that was supposed to have been restored was still missing.
 *
 * It happened to agree with the shipped docker-compose, whose `DATABASE_URL`
 * resolves to the same `/app/data/rudder.db` the relative path landed on. That
 * is what kept it from being noticed.
 */
const DB_PATH = resolveDbPath(join(dirname(fileURLToPath(import.meta.url)), '../../../data'));
/** Beside the database, so the staging copy is always on the same volume. */
const TEMP_DIR = join(dirname(DB_PATH), 'tmp');
const AZURE_API_VERSION = '2020-10-02';

function getConfig() {
  return db.select().from(backupConfig).get();
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function azureDate(): string {
  return new Date().toUTCString();
}

function buildSharedKeyAuth(
  method: string,
  account: string,
  accessKeyBase64: string,
  path: string,
  headers: Record<string, string>,
  contentLength: number,
  contentType: string,
): string {
  // Canonical headers: lowercase, sorted, trimmed
  const canonicalHeaders = Object.entries(headers)
    .filter(([k]) => k.startsWith('x-ms-'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join('\n');

  // StringToSign for SharedKey
  const stringToSign = [
    method,                  // VERB
    '',                      // Content-Encoding
    '',                      // Content-Language
    contentLength > 0 ? String(contentLength) : '', // Content-Length
    '',                      // Content-MD5
    contentType || '',       // Content-Type
    '',                      // Date
    '',                      // If-Modified-Since
    '',                      // If-Match
    '',                      // If-None-Match
    '',                      // If-Unmodified-Since
    '',                      // Range
    canonicalHeaders,        // CanonicalizedHeaders
    `/${account}${path}`,    // CanonicalizedResource
  ].join('\n');

  const key = Buffer.from(accessKeyBase64, 'base64');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
  return `SharedKey ${account}:${signature}`;
}

export async function performBackup(): Promise<{ success: boolean; message: string }> {
  const config = getConfig();

  if (!config) {
    return { success: false, message: 'Backup not configured' };
  }

  if (!config.enabled) {
    return { success: false, message: 'Backup is disabled' };
  }

  let accessKey: string;
  try {
    accessKey = decrypt(config.accessKey);
  } catch (e: any) {
    const msg = 'Failed to decrypt access key: ' + e.message;
    await updateStatus('failed: ' + msg);
    return { success: false, message: msg };
  }

  // Stage a snapshot to upload from.
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }

  const now = new Date();
  const blobName = `rudder-backup-${formatDate(now)}.db`;
  const tempPath = join(TEMP_DIR, blobName);

  try {
    // `VACUUM INTO`, not `copyFileSync`.
    //
    // The database runs in WAL mode (see $lib/db), so committed transactions
    // live in `rudder.db-wal` until a checkpoint moves them across. Copying the
    // main file alone therefore silently omitted every write since the last
    // checkpoint — and a copy taken *during* one is not a consistent snapshot at
    // all, only a file that happens to open. Both produce a backup that restores
    // to something that was never the state of the system.
    //
    // `VACUUM INTO` asks SQLite for the snapshot instead: it reads through the
    // same connection the application writes on, includes the WAL, and writes a
    // single self-contained file, all while other queries keep running.
    sqlite.run('VACUUM INTO ?', [tempPath]);
  } catch (e: any) {
    const msg = 'Failed to snapshot database: ' + e.message;
    await updateStatus('failed: ' + msg);
    return { success: false, message: msg };
  }

  try {
    const fileData = readFileSync(tempPath);
    const account = config.storageAccountName;
    const container = config.containerName;
    const contentType = 'application/octet-stream';
    const date = azureDate();
    const path = `/${container}/${blobName}`;

    const msHeaders: Record<string, string> = {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-date': date,
      'x-ms-version': AZURE_API_VERSION,
    };

    const auth = buildSharedKeyAuth(
      'PUT',
      account,
      accessKey,
      path,
      msHeaders,
      fileData.length,
      contentType,
    );

    const url = `https://${account}.blob.core.windows.net${path}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileData.length),
        'Authorization': auth,
        ...msHeaders,
      },
      body: fileData,
    });

    if (!response.ok) {
      const text = await response.text();
      const msg = `Azure upload failed (${response.status}): ${text.substring(0, 200)}`;
      await updateStatus('failed: ' + msg);
      return { success: false, message: msg };
    }

    await db.update(backupConfig).set({
      lastBackupAt: now,
      lastBackupStatus: 'success',
      updatedAt: now,
    });

    return { success: true, message: `Backup uploaded: ${blobName}` };
  } catch (e: any) {
    const msg = 'Backup failed: ' + e.message;
    await updateStatus('failed: ' + msg);
    return { success: false, message: msg };
  } finally {
    // Cleanup temp file
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch { /* ignore cleanup errors */ }
  }
}

async function updateStatus(status: string) {
  try {
    await db.update(backupConfig).set({
      lastBackupStatus: status,
      updatedAt: new Date(),
    });
  } catch { /* ignore */ }
}

export async function listBackups(): Promise<{ name: string; size: number; lastModified: string }[]> {
  const config = getConfig();
  if (!config) return [];

  let accessKey: string;
  try {
    accessKey = decrypt(config.accessKey);
  } catch {
    return [];
  }

  const account = config.storageAccountName;
  const container = config.containerName;
  const date = azureDate();

  const queryParams = 'restype=container&comp=list&prefix=rudder-backup-';

  const msHeaders: Record<string, string> = {
    'x-ms-date': date,
    'x-ms-version': AZURE_API_VERSION,
  };

  // For list blobs, CanonicalizedResource includes query params
  const canonicalHeaders = Object.entries(msHeaders)
    .filter(([k]) => k.startsWith('x-ms-'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join('\n');

  const stringToSign = [
    'GET',   // VERB
    '',      // Content-Encoding
    '',      // Content-Language
    '',      // Content-Length
    '',      // Content-MD5
    '',      // Content-Type
    '',      // Date
    '',      // If-Modified-Since
    '',      // If-Match
    '',      // If-None-Match
    '',      // If-Unmodified-Since
    '',      // Range
    canonicalHeaders,
    `/${account}/${container}\ncomp:list\nprefix:rudder-backup-\nrestype:container`,
  ].join('\n');

  const key = Buffer.from(accessKey, 'base64');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
  const auth = `SharedKey ${account}:${signature}`;

  const url = `https://${account}.blob.core.windows.net/${container}?${queryParams}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': auth,
        ...msHeaders,
      },
    });

    if (!response.ok) return [];

    const xml = await response.text();
    return parseListBlobsXml(xml);
  } catch {
    return [];
  }
}

function parseListBlobsXml(xml: string): { name: string; size: number; lastModified: string }[] {
  const blobs: { name: string; size: number; lastModified: string }[] = [];
  const blobRegex = /<Blob>[\s\S]*?<\/Blob>/g;
  let match;
  while ((match = blobRegex.exec(xml)) !== null) {
    const blobXml = match[0];
    const nameMatch = /<Name>(.*?)<\/Name>/.exec(blobXml);
    const sizeMatch = /<Content-Length>(\d+)<\/Content-Length>/.exec(blobXml);
    const dateMatch = /<Last-Modified>(.*?)<\/Last-Modified>/.exec(blobXml);
    if (nameMatch) {
      blobs.push({
        name: nameMatch[1],
        size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
        lastModified: dateMatch ? dateMatch[1] : '',
      });
    }
  }
  // Sort newest first
  blobs.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return blobs;
}

/** The 16 bytes every SQLite file starts with, including the trailing NUL. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export async function restoreBackup(blobName: string): Promise<{ success: boolean; message: string }> {
  const config = getConfig();
  if (!config) {
    return { success: false, message: 'Backup not configured' };
  }

  // The blob name is put straight into the request path, so `..` in it would
  // reach a different container in the same storage account. Restores are
  // admin-only, but a restore is also the one operation that overwrites the
  // whole database, and the caller has no business naming anything but a backup.
  if (!/^rudder-backup-[0-9-]+\.db$/.test(blobName)) {
    return {
      success: false,
      message: `"${blobName}" is not a Rudder backup name. Pick one from the list of backups.`,
    };
  }

  let accessKey: string;
  try {
    accessKey = decrypt(config.accessKey);
  } catch (e: any) {
    return { success: false, message: 'Failed to decrypt access key: ' + e.message };
  }

  const account = config.storageAccountName;
  const container = config.containerName;
  const date = azureDate();
  const path = `/${container}/${blobName}`;

  const msHeaders: Record<string, string> = {
    'x-ms-date': date,
    'x-ms-version': AZURE_API_VERSION,
  };

  const auth = buildSharedKeyAuth(
    'GET',
    account,
    accessKey,
    path,
    msHeaders,
    0,
    '',
  );

  const url = `https://${account}.blob.core.windows.net${path}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': auth,
        ...msHeaders,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, message: `Download failed (${response.status}): ${text.substring(0, 200)}` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Checked before the live database is overwritten, because this is the one
    // operation with nothing to fall back on. A truncated download, or an Azure
    // error document served with a 200, would otherwise be written over
    // rudder.db and take the installation with it.
    if (buffer.length < SQLITE_MAGIC.length || !buffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      return {
        success: false,
        message:
          `"${blobName}" is not a SQLite database (${buffer.length} bytes, wrong header). ` +
          `Nothing was changed.`,
      };
    }

    // Keep the database that is being replaced. A restore aimed at the wrong
    // backup is otherwise unrecoverable, and the operator finds out after the
    // restart this instructs them to perform.
    try {
      if (existsSync(DB_PATH)) copyFileSync(DB_PATH, `${DB_PATH}.pre-restore`);
    } catch (e: any) {
      return {
        success: false,
        message: `Could not set the current database aside first (${e.message}). Nothing was changed.`,
      };
    }

    writeFileSync(DB_PATH, buffer);

    // The write-ahead log and shared-memory index belong to the database that
    // was just replaced. Left in place, SQLite replays that WAL over the
    // restored file on the next open — so the restore is silently undone, or
    // worse, half-applied. They are removed here rather than left for the
    // restart to trip over.
    for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      try {
        if (existsSync(sidecar)) unlinkSync(sidecar);
      } catch (e) {
        console.error('[backup] Could not remove', sidecar, e);
      }
    }

    return {
      success: true,
      message: `Database restored from ${blobName}. Server restart required for changes to take effect.`,
    };
  } catch (e: any) {
    return { success: false, message: 'Restore failed: ' + e.message };
  }
}

export async function testConnection(): Promise<{ success: boolean; message: string }> {
  const config = getConfig();
  if (!config) {
    return { success: false, message: 'Backup not configured' };
  }

  try {
    const blobs = await listBackups();
    return { success: true, message: `Connection successful. Found ${blobs.length} existing backup(s).` };
  } catch (e: any) {
    return { success: false, message: 'Connection test failed: ' + e.message };
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function startBackupScheduler() {
  // Check on startup if backup is overdue
  setTimeout(async () => {
    try {
      const config = getConfig();
      if (config && config.enabled) {
        const lastBackup = config.lastBackupAt ? new Date(config.lastBackupAt).getTime() : 0;
        if (Date.now() - lastBackup > TWENTY_FOUR_HOURS_MS) {
          console.log('[backup] Running overdue startup backup...');
          const result = await performBackup();
          console.log('[backup] Startup backup result:', result.message);
        }
      }
    } catch (e) {
      console.error('[backup] Startup backup check failed:', e);
    }
  }, 5000); // 5s delay to let DB fully initialize

  // Schedule daily backup
  setInterval(async () => {
    try {
      const config = getConfig();
      if (config && config.enabled) {
        console.log('[backup] Running scheduled daily backup...');
        const result = await performBackup();
        console.log('[backup] Daily backup result:', result.message);
      }
    } catch (e) {
      console.error('[backup] Scheduled backup failed:', e);
    }
  }, TWENTY_FOUR_HOURS_MS);
}
