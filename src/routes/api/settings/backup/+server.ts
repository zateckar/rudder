import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { backupConfig } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt } from '$lib/server/encryption';
import { performBackup, listBackups, restoreBackup, testConnection } from '$lib/server/backup';
import type { RequestHandler } from './$types';
import { requireAdminUser, route } from '$lib/server/auth';

/** GET: Return backup config (without decrypted access key) + list of available backups */
export const GET: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const config = db.select().from(backupConfig).get();

  let backups: { name: string; size: number; lastModified: string }[] = [];
  if (config) {
    try {
      backups = await listBackups();
    } catch { /* ignore */ }
  }

  return json({
    config: config
      ? {
          id: config.id,
          storageAccountName: config.storageAccountName,
          containerName: config.containerName,
          enabled: config.enabled,
          lastBackupAt: config.lastBackupAt,
          lastBackupStatus: config.lastBackupStatus,
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
        }
      : null,
    backups,
  });
});

/** POST: Create/update backup config */
export const POST: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const body = await event.request.json();
  const { storageAccountName, accessKey, containerName } = body;

  if (!storageAccountName || !accessKey) {
    return json({ error: 'Storage account name and access key are required' }, { status: 400 });
  }

  const encryptedKey = encrypt(accessKey);
  const now = new Date();

  const existing = db.select().from(backupConfig).get();

  if (existing) {
    await db.update(backupConfig).set({
      storageAccountName,
      accessKey: encryptedKey,
      containerName: containerName || 'rudder-backups',
      enabled: true,
      updatedAt: now,
    });
  } else {
    await db.insert(backupConfig).values({
      id: crypto.randomUUID(),
      storageAccountName,
      accessKey: encryptedKey,
      containerName: containerName || 'rudder-backups',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return json({ success: true });
});

/** PUT: Trigger manual backup now */
export const PUT: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const result = await performBackup();
  return json(result, { status: result.success ? 200 : 500 });
});

/** PATCH: Restore from a backup OR test connection */
export const PATCH: RequestHandler = route(async (event) => {
  requireAdminUser(event);
  const { request } = event;

  const body = await request.json();

  if (body.action === 'test') {
    const result = await testConnection();
    return json(result, { status: result.success ? 200 : 400 });
  }

  if (body.blobName) {
    const result = await restoreBackup(body.blobName);
    return json(result, { status: result.success ? 200 : 500 });
  }

  return json({ error: 'Missing blobName or action' }, { status: 400 });
});
