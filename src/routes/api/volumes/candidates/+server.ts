import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { applications, workers } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { AuthorizationError, isTeamMember, requireUser, route } from '$lib/server/auth';
import { storageForApplications } from '$lib/server/app-volumes';
import { bareVolumeAccessForTeam } from '$lib/server/deployment-volumes';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { volumeOwnerApp8 } from '$lib/server/volumes';
import { ValidationError } from '$lib/server/validation';

/** One existing volume a new application of the team might use. */
interface Candidate {
  /** The Podman volume name — what a manifest has to write to mount it. */
  name: string;
  /** The applications that declare it or left it behind. */
  apps: string[];
  /** Where those applications mount it: the likeliest path for a new one too. */
  paths: string[];
  sizeBytes: number | null;
  /** On the worker now. False for a volume declared but never deployed. */
  present: boolean;
  /** Whether a new application's manifest may mount it under the mount policy. */
  mountable: boolean;
  /** Why not, when it may not. */
  reason: string | null;
}

/**
 * Existing volumes on `workerId` that `teamId`'s applications use, for the New
 * Application page to suggest.
 *
 * Scoped to the team on purpose. A worker also holds other teams' volumes and
 * its own infrastructure's, and suggesting one of those — even listing its name
 * — is a leak; the team's own applications are what someone creating another
 * one is likely to want to share storage with.
 *
 * `mountable` follows the mount policy rather than restating it: a volume whose
 * name Rudder generated for an application (`./data` in a compose file becomes
 * `rudder-<app8>-<service>-data`) may only be mounted by that application, so
 * it is listed but flagged. A plain name — compose `models:/models`, a
 * Kubernetes `claimName` — goes through the deploy's own ownership check
 * (`bareVolumeAccessForTeam`), so a volume suggested here is one the deploy
 * accepts: notably, one on the worker that no container of the team mounts any
 * more is refused there and flagged here.
 */
export const GET: RequestHandler = route(async (event) => {
  const ctx = requireUser(event);
  const workerId = event.url.searchParams.get('workerId');
  const teamId = event.url.searchParams.get('teamId');
  if (!workerId || !teamId) throw new ValidationError('workerId and teamId are required');

  if (ctx.user.role !== 'admin' && !(await isTeamMember(ctx.user.id, teamId))) {
    throw new AuthorizationError('Access denied to this team', 403);
  }

  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) throw new AuthorizationError('Worker not found', 404);

  const apps = await db
    .select()
    .from(applications)
    .where(and(eq(applications.teamId, teamId), eq(applications.workerId, workerId)))
    .all();
  if (apps.length === 0) return json({ candidates: [], unreachable: null });

  const fleet = await storageForApplications(apps, { sizes: true });

  const byName = new Map<string, Candidate>();
  for (const { app, storage } of fleet.applications) {
    for (const v of storage.volumes) {
      // Another team's volume, named in this team's manifest. Not ours to suggest.
      if (v.origin === 'foreign') continue;

      let candidate = byName.get(v.name);
      if (!candidate) {
        const owner = volumeOwnerApp8(v.name);
        candidate = {
          name: v.name,
          apps: [],
          paths: [],
          sizeBytes: v.sizeBytes,
          present: v.present,
          mountable: owner === null,
          reason:
            owner === null
              ? null
              : `Rudder named it for ${app.name}, so only ${app.name} may mount it. Give a volume a ` +
                `plain name in a manifest (models:/models) to share it between applications.`,
        };
        byName.set(v.name, candidate);
      }
      if (!candidate.apps.includes(app.name)) candidate.apps.push(app.name);
      for (const t of v.targets) {
        if (!candidate.paths.includes(t.path)) candidate.paths.push(t.path);
      }
      candidate.present ||= v.present;
      candidate.sizeBytes ??= v.sizeBytes;
    }
  }

  const bare = [...byName.values()].filter((c) => c.mountable);
  if (bare.length) {
    let access: Map<string, string | null>;
    try {
      access = await bareVolumeAccessForTeam(teamId, worker, bare.map((c) => c.name), getRestPodmanClient(worker));
    } catch (e) {
      // Unverifiable is not mountable: the deploy fails closed the same way.
      const reason = e instanceof AuthorizationError ? e.message : 'Could not verify volume ownership on the worker.';
      access = new Map(bare.map((c) => [c.name, reason]));
    }
    for (const c of bare) {
      const reason = access.get(c.name);
      if (reason) {
        c.mountable = false;
        c.reason = reason;
      }
    }
  }

  const unreachable = [...fleet.workers.values()].find((w) => w.unreachable)?.unreachable ?? null;

  return json({
    // Mountable first, then the largest — the ones most worth not duplicating.
    candidates: [...byName.values()].sort(
      (a, b) =>
        Number(b.mountable) - Number(a.mountable) ||
        (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
        a.name.localeCompare(b.name),
    ),
    unreachable,
  });
});
