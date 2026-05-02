/**
 * Core v1 catch-all: namespaces, pods, pod logs.
 *
 * Paths handled:
 *   GET    namespaces
 *   GET    namespaces/:ns
 *   GET    namespaces/:ns/pods
 *   GET    namespaces/:ns/pods/:pod
 *   GET    namespaces/:ns/pods/:pod/log
 *   DELETE namespaces/:ns/pods/:pod
 */

import {
  authenticateK8s,
  k8sError,
  k8sJson,
  resolveTeamBySlug,
  getAccessibleTeams,
} from '$lib/server/k8s/auth';
import {
  teamToNamespace,
  containerToPod,
  k8sList,
  matchPath,
} from '$lib/server/k8s/mapper';
import { db } from '$lib/db';
import { applications, containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

// ── GET ────────────────────────────────────────────────────────

export async function GET({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  // namespaces
  if ((m = matchPath(path, 'namespaces')) !== null) {
    const teams = await getAccessibleTeams(ctx);
    return k8sJson(k8sList('NamespaceList', 'v1', teams.map(teamToNamespace)));
  }

  // namespaces/:ns
  if ((m = matchPath(path, 'namespaces/:ns')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);
    return k8sJson(teamToNamespace(team));
  }

  // namespaces/:ns/pods
  if ((m = matchPath(path, 'namespaces/:ns/pods')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const teamApps = await db
      .select()
      .from(applications)
      .where(eq(applications.teamId, team.id))
      .all();
    const pods: any[] = [];
    for (const app of teamApps) {
      const appContainers = await db
        .select()
        .from(containers)
        .where(eq(containers.applicationId, app.id))
        .all();
      for (const c of appContainers) {
        pods.push(containerToPod(c, app.name, team.slug));
      }
    }
    return k8sJson(k8sList('PodList', 'v1', pods));
  }

  // namespaces/:ns/pods/:pod
  if ((m = matchPath(path, 'namespaces/:ns/pods/:pod')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const result = await findPodInNamespace(team.id, team.slug, m.pod);
    if (!result) return k8sError(404, `pods "${m.pod}" not found`);
    return k8sJson(result.pod);
  }

  // namespaces/:ns/pods/:pod/log
  if ((m = matchPath(path, 'namespaces/:ns/pods/:pod/log')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const result = await findPodInNamespace(team.id, team.slug, m.pod);
    if (!result) return k8sError(404, `pods "${m.pod}" not found`);

    const url = new URL(request.url);
    const tailLines = parseInt(url.searchParams.get('tailLines') || '1000');
    const timestamps = url.searchParams.get('timestamps') === 'true';
    return await fetchPodLogs(result.container, tailLines, timestamps);
  }

  return k8sError(
    404,
    `the server doesn't have a resource type at path /api/v1/${path}`,
  );
}

// ── DELETE ─────────────────────────────────────────────────────

export async function DELETE({
  request,
  params,
}: {
  request: Request;
  params: { path: string };
}) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  const path = params.path;
  let m: Record<string, string> | null;

  // namespaces/:ns/pods/:pod
  if ((m = matchPath(path, 'namespaces/:ns/pods/:pod')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);

    const result = await findPodInNamespace(team.id, team.slug, m.pod);
    if (!result) return k8sError(404, `pods "${m.pod}" not found`);

    // Remove via Podman (best-effort)
    if (result.container.workerId) {
      const worker = await db
        .select()
        .from(workers)
        .where(eq(workers.id, result.container.workerId))
        .get();
      if (worker) {
        try {
          const client = getRestPodmanClient(worker);
          await client.removeContainer(result.container.containerId, true);
          client.destroy();
        } catch {
          /* best-effort */
        }
      }
    }

    await db.delete(containers).where(eq(containers.id, result.container.id));

    return k8sJson({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Success',
      code: 200,
    });
  }

  return k8sError(
    405,
    `Method DELETE not allowed for /api/v1/${path}`,
    'MethodNotAllowed',
  );
}

// ── Helpers ────────────────────────────────────────────────────

async function findPodInNamespace(
  teamId: string,
  teamSlug: string,
  podName: string,
) {
  const teamApps = await db
    .select()
    .from(applications)
    .where(eq(applications.teamId, teamId))
    .all();

  for (const app of teamApps) {
    const appContainers = await db
      .select()
      .from(containers)
      .where(eq(containers.applicationId, app.id))
      .all();
    const container = appContainers.find((c) => c.name === podName);
    if (container) {
      return {
        pod: containerToPod(container, app.name, teamSlug),
        container,
        app,
      };
    }
  }
  return null;
}

async function fetchPodLogs(
  container: { id: string; containerId: string; workerId: string | null },
  tailLines: number,
  timestamps: boolean,
) {
  if (!container.workerId) {
    return new Response('Error: container has no worker assigned\n', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const worker = await db
    .select()
    .from(workers)
    .where(eq(workers.id, container.workerId))
    .get();
  if (!worker) {
    return new Response('Error: worker not found\n', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    const client = getRestPodmanClient(worker);
    const logs = await client.getContainerLogs(container.containerId, {
      stdout: true,
      stderr: true,
      tail: tailLines,
      timestamps,
    });
    client.destroy();
    return new Response(logs, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error: any) {
    return new Response(`Error fetching logs: ${error.message}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
