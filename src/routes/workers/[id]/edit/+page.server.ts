import { redirect, fail, error } from '@sveltejs/kit';
import { db, safeWorkerColumns } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { domainFormatError } from '$lib/server/domains';
import { workerTargetError } from '$lib/server/ssh-target';
import { currentUser, isAdmin, requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { params: { id: string }; locals: App.Locals }) => {
  const user = requirePageAdmin(event).user;

  const worker = await db.select(safeWorkerColumns).from(workers).where(eq(workers.id, event.params.id)).get();
  if (!worker) throw error(404, 'Worker not found');

  return { user, worker };
};

export const actions = {
  default: async ({ params, request, locals }: { params: { id: string }; request: Request; locals: App.Locals }) => {
    const ctx = currentUser({ locals });
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    if (!isAdmin(ctx)) return fail(403, { error: 'Admin access required' });

    const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
    if (!worker) return fail(404, { error: 'Worker not found' });

    const formData = await request.formData();

    const name = formData.get('name')?.toString();
    const hostname = formData.get('hostname')?.toString();
    const sshPort = parseInt(formData.get('sshPort')?.toString() || '22');
    const sshUser = formData.get('sshUser')?.toString();
    const baseDomain = formData.get('baseDomain')?.toString() || '';
    const podmanApiUrl = formData.get('podmanApiUrl')?.toString() || '';

    // Same rule as the create form: this value is the stem of every Traefik
    // `Host()` rule on the worker, including its own auth/metrics/podman-api
    // routers.
    if (baseDomain) {
      const badDomain = domainFormatError(baseDomain);
      if (badDomain) return fail(400, { error: `Base domain: ${badDomain}` });
    }

    if (!name || !hostname || !sshUser) {
      return fail(400, { error: 'Missing required fields' });
    }

    // Same rule as the create form. An edit is the more important of the two to
    // check: a worker created cleanly can be renamed here afterwards, and the
    // next provisioning run is what carries the value to a root shell.
    const badTarget = workerTargetError({ name, hostname, sshUser });
    if (badTarget) return fail(400, { error: badTarget });

    const updates: Record<string, any> = {
      name,
      hostname,
      sshPort,
      sshUser,
      baseDomain: baseDomain || null,
      podmanApiUrl: podmanApiUrl || (baseDomain ? `https://podman-api.${baseDomain}` : `https://${hostname}`),
    };

    await db.update(workers).set(updates).where(eq(workers.id, params.id));

    throw redirect(303, `/workers/${params.id}`);
  },
};
