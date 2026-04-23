import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  try {
    const client = getRestPodmanClient(worker);
    try {
      const networks = await client.listNetworks();
      return json({
        networks: networks.map((net: any) => ({
          name: net.Name,
          id: net.Id,
          driver: net.Driver || 'bridge',
          subnet: net.IPAM?.Config?.[0]?.Subnet || net.Subnets?.[0]?.Subnet || '—',
          gateway: net.IPAM?.Config?.[0]?.Gateway || net.Subnets?.[0]?.Gateway || '—',
          created: net.Created,
          containers: net.Containers ? Object.keys(net.Containers).length : 0,
          internal: net.Internal || false,
        })),
      });
    } finally {
      client.destroy();
    }
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const body = await request.json();
  const networkName = body.name;
  const driver = body.driver || 'bridge';

  if (!networkName || typeof networkName !== 'string') {
    return json({ error: 'Network name is required' }, { status: 400 });
  }

  if (!['bridge', 'macvlan'].includes(driver)) {
    return json({ error: 'Driver must be "bridge" or "macvlan"' }, { status: 400 });
  }

  try {
    const client = getRestPodmanClient(worker);
    try {
      const result = await client.createNetwork(networkName, driver);
      return json({ success: true, id: result.Id });
    } finally {
      client.destroy();
    }
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const networkName = url.searchParams.get('name');
  if (!networkName) {
    return json({ error: 'Network name is required (?name=...)' }, { status: 400 });
  }

  const protectedNetworks = ['podman', 'bridge', 'host', 'none'];
  if (protectedNetworks.includes(networkName)) {
    return json({ error: `Cannot delete default network "${networkName}"` }, { status: 400 });
  }

  try {
    const client = getRestPodmanClient(worker);
    try {
      await client.removeNetwork(networkName);
      return json({ success: true });
    } finally {
      client.destroy();
    }
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
