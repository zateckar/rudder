import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { domainFormatError } from '$lib/server/domains';
import { workerTargetError } from '$lib/server/ssh-target';
import { currentUser, isAdmin, requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  return { user: requirePageAdmin(event).user };
};

export const actions = {
  default: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = currentUser(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    if (!isAdmin(ctx)) return fail(403, { error: 'Admin access required' });

    const formData = await event.request.formData();
    const name = formData.get('name')?.toString();
    const hostname = formData.get('hostname')?.toString();
    const sshPort = parseInt(formData.get('sshPort')?.toString() || '22');
    const sshUser = formData.get('sshUser')?.toString();
    const baseDomain = formData.get('baseDomain')?.toString() || '';

    if (!name || !hostname || !sshUser) {
      return fail(400, { error: 'Missing required fields' });
    }

    // The name is substituted into the provisioning script that runs on the
    // worker as root, and the hostname and user become the `user@host` argument
    // of an `ssh` invocation on this host. This form checked the base domain and
    // nothing else, so all three arrived unvalidated — `schemas.createWorker`
    // exists and constrains the name, but no page action was using it.
    const badTarget = workerTargetError({ name, hostname, sshUser });
    if (badTarget) return fail(400, { error: badTarget });

    // The base domain is the stem of every hostname on this worker, and each one
    // becomes a Traefik `Host()` rule — for applications, and for the worker's
    // own auth/metrics/podman-api routers. A value carrying rule syntax would be
    // interpolated into all of them; a merely malformed one makes Traefik reject
    // the dynamic file whole, which takes every route on the worker down at once.
    if (baseDomain) {
      const badDomain = domainFormatError(baseDomain);
      if (badDomain) return fail(400, { error: `Base domain: ${badDomain}` });
    }

    const workerId = crypto.randomUUID();

    // Derive podman API URL from base domain or fall back to IP-based
    const podmanApiUrl = baseDomain
      ? `https://podman-api.${baseDomain}`
      : `https://${hostname}`;

    await db.insert(workers).values({
      id: workerId,
      name,
      hostname,
      sshPort,
      sshUser,
      baseDomain: baseDomain || null,
      podmanApiUrl,
      status: 'offline',
      createdAt: new Date(),
    });

    throw redirect(303, '/workers');
  }
};
