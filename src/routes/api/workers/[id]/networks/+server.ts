import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

/** Podman's own networks. Removing one of these breaks the worker. */
const PROTECTED_NETWORKS = ['podman', 'bridge', 'host', 'none'];

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const networks = await withPodman(worker, (c) => c.listNetworks());

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
});

export const POST: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const body = await event.request.json();
  const networkName = body.name;
  const driver = body.driver || 'bridge';

  if (!networkName || typeof networkName !== 'string') {
    return json({ error: 'Network name is required' }, { status: 400 });
  }
  if (!['bridge', 'macvlan'].includes(driver)) {
    return json({ error: 'Driver must be "bridge" or "macvlan"' }, { status: 400 });
  }

  const result = await withPodman(worker, (c) => c.createNetwork(networkName, driver));
  return json({ success: true, id: result.Id });
});

export const DELETE: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const networkName = event.url.searchParams.get('name');
  if (!networkName) {
    return json({ error: 'Network name is required (?name=...)' }, { status: 400 });
  }
  if (PROTECTED_NETWORKS.includes(networkName)) {
    return json({ error: `Cannot delete default network "${networkName}"` }, { status: 400 });
  }

  await withPodman(worker, (c) => c.removeNetwork(networkName));
  return json({ success: true });
});
