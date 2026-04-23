import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { sshKeys, users, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { createSSHKey, listSSHKeys } from '$lib/server/ssh';

export const GET: RequestHandler = async ({ cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const keys = await listSSHKeys();
  return json(keys);
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const body = await request.json();
  const { name, privateKey } = body;

  if (!name || !privateKey) return json({ error: 'Name and private key are required' }, { status: 400 });

  try {
    // Derive public key from private key
    const { execSync } = await import('child_process');
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const tempKeyPath = join(tmpdir(), `rudder_pub_${Date.now()}.key`);
    writeFileSync(tempKeyPath, privateKey, { mode: 0o600 });

    let publicKey: string;
    try {
      publicKey = execSync(`ssh-keygen -y -f "${tempKeyPath}"`, { encoding: 'utf8' }).trim();
    } catch {
      unlinkSync(tempKeyPath);
      return json({ error: 'Invalid private key — could not derive public key' }, { status: 400 });
    }
    unlinkSync(tempKeyPath);

    const id = await createSSHKey(name, privateKey, publicKey);
    return json({ id, name, publicKey }, { status: 201 });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Key ID required' }, { status: 400 });

  // Check if any workers use this key
  const usedBy = await db.select({ id: workers.id, name: workers.name }).from(workers).where(eq(workers.sshKeyId, id)).all();
  if (usedBy.length > 0) {
    return json({ error: `Key is used by worker(s): ${usedBy.map(w => w.name).join(', ')}` }, { status: 409 });
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, id));
  return json({ success: true });
};
