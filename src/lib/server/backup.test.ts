import { afterAll, beforeAll, expect, test } from 'bun:test';
import { db, sqlite } from '$lib/db';
import { backupConfig } from '$lib/db/schema';
import { encrypt } from './encryption';
import { listBackups, restoreBackup, testConnection } from './backup';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';

const configId = crypto.randomUUID();
beforeAll(async () => {
  await db.insert(backupConfig).values({ id: configId, storageAccountName: 'review-test',
    containerName: 'backups', accessKey: encrypt('YQ=='), createdAt: new Date(), updatedAt: new Date() });
});
afterAll(async () => { await db.delete(backupConfig).where(eq(backupConfig.id, configId)); });

async function withFetch<T>(fetcher: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = fetcher;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('Azure 403 is a failed connection test and a failed list', async () => {
  await withFetch((async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch, async () => {
    expect(await testConnection()).toMatchObject({ success: false });
    await expect(listBackups()).rejects.toThrow('403');
  });
});

test('network failure is a failed connection test', async () => {
  await withFetch((async () => { throw new Error('connection refused'); }) as unknown as typeof fetch, async () => {
    expect(await testConnection()).toEqual({ success: false,
      message: 'Connection test failed: Could not list Azure backups: connection refused' });
  });
});

test('an empty authorized listing is a successful connection test', async () => {
  await withFetch((async () => new Response('<EnumerationResults><Blobs /></EnumerationResults>')) as unknown as typeof fetch, async () => {
    expect(await testConnection()).toEqual({ success: true, message: 'Connection successful. Found 0 existing backup(s).' });
  });
});

test('an HTTP 200 error document is not a successful backup listing', async () => {
  await withFetch((async () => new Response('<Error>Storage unavailable</Error>')) as unknown as typeof fetch, async () => {
    expect(await testConnection()).toMatchObject({ success: false });
  });
});

test('failed decryption does not report a successful connection', async () => {
  await db.update(backupConfig).set({ accessKey: 'invalid' }).where(eq(backupConfig.id, configId));
  try { expect(await testConnection()).toMatchObject({ success: false }); }
  finally { await db.update(backupConfig).set({ accessKey: encrypt('YQ==') }).where(eq(backupConfig.id, configId)); }
});

test('restore API stages the snapshot without replacing the live database', async () => {
  const path = process.env.DATABASE_URL!;
  const snapshot = join(dirname(path), `${crypto.randomUUID()}.db`);
  sqlite.run('VACUUM INTO ?', [snapshot]);
  const bytes = readFileSync(snapshot);
  const liveBefore = sqlite.query('SELECT count(*) AS n FROM backup_config').get();
  try {
    await withFetch((async () => new Response(bytes)) as unknown as typeof fetch, async () => {
      expect(await restoreBackup('rudder-backup-2026-10-04-120000.db')).toMatchObject({ success: true });
      expect(sqlite.query('SELECT count(*) AS n FROM backup_config').get()).toEqual(liveBefore);
      expect(existsSync(`${path}.restore-pending.json`)).toBe(true);
      expect(await restoreBackup('rudder-backup-2026-10-04-120000.db')).toMatchObject({ success: false });
    });
  } finally {
    const marker = `${path}.restore-pending.json`;
    if (existsSync(marker)) {
      const journal = JSON.parse(readFileSync(marker, 'utf8'));
      rmSync(join(dirname(path), journal.candidate)); rmSync(marker);
    }
    rmSync(snapshot);
  }
});
