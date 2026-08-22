/**
 * Core v1 catch-all: namespaces, pods, pod logs, events.
 *
 * Paths handled:
 *   GET    namespaces
 *   GET    namespaces/:ns
 *   GET    namespaces/:ns/pods
 *   GET    namespaces/:ns/pods/:pod
 *   GET    namespaces/:ns/pods/:pod/log   (with follow=true streaming)
 *   GET    namespaces/:ns/events
 *   GET    events
 *   DELETE namespaces/:ns/pods/:pod
 *
 * `kubectl exec` is a WebSocket upgrade and cannot be served from a
 * `+server.ts` — see src/lib/server/ws/handlers.ts.
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
  parseTailLines,
  podNameOf,
} from '$lib/server/k8s/mapper';
import { db } from '$lib/db';
import { applications, containers, deployments, workers } from '$lib/db/schema';
import { desc, eq } from 'drizzle-orm';
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
    const tailLines = parseTailLines(url.searchParams.get('tailLines'));
    const timestamps = url.searchParams.get('timestamps') === 'true';
    const follow = url.searchParams.get('follow') === 'true';
    return await fetchPodLogs(result.container, tailLines, timestamps, follow);
  }

  // namespaces/:ns/events — what `kubectl get events` and `kubectl describe`
  // read. Mapped from deployment history, which is the only event stream
  // Rudder actually has; container-level events would need the Podman event
  // socket per worker and are not included here.
  if ((m = matchPath(path, 'namespaces/:ns/events')) !== null) {
    const team = await resolveTeamBySlug(ctx, m.ns);
    if (!team) return k8sError(404, `namespaces "${m.ns}" not found`);
    return k8sJson(k8sList('EventList', 'v1', await eventsForTeam(team.id, team.slug)));
  }

  // Cluster-wide events: every namespace this key can reach.
  if ((m = matchPath(path, 'events')) !== null) {
    const accessible = await getAccessibleTeams(ctx);
    const all: any[] = [];
    for (const team of accessible) {
      all.push(...(await eventsForTeam(team.id, team.slug)));
    }
    return k8sJson(k8sList('EventList', 'v1', all));
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
    // Compared through podNameOf: discovered containers carry Podman's leading
    // slash in the database, but the pod name kubectl was shown does not.
    const container = appContainers.find((c) => podNameOf(c.name) === podNameOf(podName));
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

/**
 * Deployment history as Kubernetes Events.
 *
 * `kubectl get events` and `kubectl describe` both read this, and deploy
 * history is the event stream Rudder actually keeps. Container-level events
 * would mean holding a Podman event subscription per worker, which is a
 * different piece of work.
 */
async function eventsForTeam(teamId: string, teamSlug: string) {
  const teamApps = await db
    .select()
    .from(applications)
    .where(eq(applications.teamId, teamId))
    .all();

  const events: any[] = [];

  for (const app of teamApps) {
    const rows = await db
      .select()
      .from(deployments)
      .where(eq(deployments.applicationId, app.id))
      .orderBy(desc(deployments.createdAt))
      .limit(50)
      .all();

    for (const d of rows) {
      const failed = d.status === 'failed';
      const at = (d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt as any)).toISOString();
      const finished = d.finishedAt
        ? (d.finishedAt instanceof Date ? d.finishedAt : new Date(d.finishedAt as any)).toISOString()
        : at;

      events.push({
        kind: 'Event',
        apiVersion: 'v1',
        metadata: {
          name: `${app.name}.v${d.version}.${d.id.slice(0, 8)}`,
          namespace: teamSlug,
          creationTimestamp: at,
          uid: d.id,
        },
        involvedObject: {
          kind: 'Deployment',
          namespace: teamSlug,
          name: app.name,
          apiVersion: 'apps/v1',
        },
        // Kubernetes only defines Normal and Warning; a failed deploy is the
        // only thing here that is not routine.
        type: failed ? 'Warning' : 'Normal',
        reason: failed ? 'DeployFailed' : d.status === 'rolled_back' ? 'RolledBack' : 'Deployed',
        message:
          d.errorMessage ??
          `version ${d.version}${d.image ? ` (${d.image})` : ''} — ${d.status}`,
        source: { component: 'rudder' },
        firstTimestamp: at,
        lastTimestamp: finished,
        count: 1,
      });
    }
  }

  // Newest first across all applications, matching kubectl's default ordering
  // expectations closely enough to be useful.
  events.sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? 1 : -1));
  return events;
}

async function fetchPodLogs(
  container: { id: string; containerId: string; workerId: string | null },
  tailLines: number,
  timestamps: boolean,
  follow = false,
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

  let client: ReturnType<typeof getRestPodmanClient>;
  try {
    client = getRestPodmanClient(worker);
  } catch (error: any) {
    return new Response(`Error connecting to worker: ${error.message}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (follow) {
    // `kubectl logs -f` holds the response open. The Podman stream is torn
    // down when the client disconnects — without that, every ^C would leave a
    // log stream running against the worker until the process restarted.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
          client.destroy();
        };

        const streamHandle = client.streamContainerLogs(
          container.containerId,
          { stdout: true, stderr: true, tail: tailLines, timestamps, follow: true },
          (line) => {
            if (closed) return;
            try { controller.enqueue(encoder.encode(line + '\n')); } catch { finish(); }
          },
          finish,
          (err) => {
            if (!closed) {
              try { controller.enqueue(encoder.encode(`error: ${err.message}\n`)); } catch { /* gone */ }
            }
            finish();
          },
        );

        (this as any).__abort = () => { streamHandle.abort(); finish(); };
      },
      cancel() {
        (this as any).__abort?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        // kubectl reads the body incrementally; a proxy that buffers would
        // make `-f` look like it hangs until the container exits.
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  try {
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
    client.destroy();
    return new Response(`Error fetching logs: ${error.message}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
