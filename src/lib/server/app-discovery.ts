/**
 * Adoption: bringing a container Rudder did not create under its management.
 *
 * This used to be called discovery, and it ran by itself. After a
 * re-provisioning it would list a worker's containers, parse Traefik router
 * labels back into a domain, infer teams from label values,
 * fabricate a `succeeded` deployment record for something it had never deployed,
 * and write application rows for all of it — with no one asked. The code
 * admitted in a comment that it could not recover an OIDC `clientSecret` or
 * `sessionEncryptionKey` from labels, and wrote `authType: 'oidc'` with a null
 * `authConfig` anyway, producing applications that could not be redeployed
 * without a human working out what was missing.
 *
 * It existed because nothing reconciled. Drift could only be recovered
 * archaeologically, so import had to guess at everything to be useful. With
 * reconciliation in place that job is gone, and what remains is much smaller:
 *
 *   `listAdoptableContainers` — read the worker, propose candidates. Writes
 *                               nothing.
 *   `adoptContainers`         — create rows for exactly the containers an
 *                               operator named.
 *
 * Nothing here runs on a timer. Adoption changes what Rudder claims to own, and
 * that is a decision, not a side effect of restarting a worker.
 *
 * ## What adoption can and cannot do
 *
 * It records what the container actually is — image, environment, mounts,
 * restart policy, and the hostname its own Traefik router serves. Those are read
 * off the container, not inferred from it.
 *
 * It cannot label the container. Podman fixes labels at creation and offers no
 * way to add one afterwards, so an adopted container does not carry
 * `rudder.managed=true` and the reconciler will not remove it. It picks the label
 * up the first time the application is deployed. Under-claiming is the right
 * direction to fail in.
 *
 * It also cannot recover a secret that only ever existed in a label — which is
 * why nothing here tries. An adopted application's auth configuration starts
 * empty, and the operator sets it.
 */

import { db } from '$lib/db';
import { applications, containers, deployments, teams, workers } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import type { Container, ContainerInspect } from '$lib/server/podman';
// A container's labels can carry an OIDC client secret stamped in by an earlier
// deploy; keep it out of Rudder's database.
import { redactSecretLabels } from '$lib/server/redaction';
import { podmanName } from '$lib/server/reconcile';
import { assertDomainAvailable } from '$lib/server/domains';

/** Platform containers. Rudder runs these; they are not applications. */
const INFRASTRUCTURE = ['traefik', 'crowdsec', 'podman-api'];

/** A container that could be adopted, and what Rudder proposes for it. */
export interface AdoptableContainer {
  containerId: string;
  name: string;
  image: string;
  /** Podman's state — `running`, `exited`, … */
  status: string;
  /**
   * Hostname the container's own Traefik router already serves, if any.
   *
   * Read from a `Host()` rule, which says exactly one thing and says it
   * unambiguously. Presented for the operator to confirm or replace, never
   * written on its own — that difference is the whole point of this rewrite.
   */
  domain: string | null;
  /** Name Rudder proposes for the application. The operator may override it. */
  suggestedName: string;
  /**
   * Team suggested by the container's `rudder.team.id` label, when that team
   * still exists. A missing or unknown team is left null rather than created:
   * inventing a team from a label is how the old code ended up with teams nobody
   * had asked for.
   */
  suggestedTeamId: string | null;
}

export function isInfrastructureContainer(container: Pick<Container, 'Names'>): boolean {
  return INFRASTRUCTURE.some((infra) =>
    (container.Names ?? []).some((n) => n.toLowerCase().includes(infra)),
  );
}

/**
 * The hostname a container's Traefik labels route to.
 *
 * This is the one thing the old label parsing did that was not a guess. A
 * `Host()` rule names a hostname; there is nothing to infer. Everything else it
 * read — rate limits, auth mode, a health check invented out of a load-balancer
 * path — is gone, because those live on the application in Rudder and are
 * editable there, and reconstructing them from labels produced values nobody had
 * chosen.
 */
export function routedDomain(labels: Record<string, string> | undefined): string | null {
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!key.startsWith('traefik.http.routers.') || !key.endsWith('.rule')) continue;
    const match = value.match(/Host\(`([^`]+)`\)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * A name for the adopted application.
 *
 * The `app` label when there is one — a container Rudder deployed under an older
 * scheme carries the application's real name there. Otherwise the container name
 * with any Rudder id suffix removed, which is the best available guess and is
 * shown to the operator before anything is written.
 */
export function proposedAppName(name: string, labels: Record<string, string> | undefined): string {
  const labelled = labels?.['app']?.trim();
  if (labelled) return labelled;
  const bare = podmanName(name);
  // `shop-1a2b3c4d` and `shop-1a2b3c4d-web` both came from Rudder; recover `shop`.
  const match = bare.match(/^(.+?)-[0-9a-f]{8}(?:-.+)?$/);
  return match ? match[1] : bare;
}

/** Environment variables worth carrying over, as `applications.environment` JSON. */
export function environmentFromContainer(inspect: ContainerInspect): string | null {
  // PATH and HOME come from the image, not from configuration. Carrying them
  // would make them look like something the operator had set.
  const entries = (inspect.Config?.Env ?? [])
    .filter((e) => !e.startsWith('PATH=') && !e.startsWith('HOME='))
    .map((e) => {
      const [key, ...rest] = e.split('=');
      return { key, value: rest.join('=') };
    })
    .filter((e) => e.key.length > 0);
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

/**
 * The container's mounts, as `applications.volumes` JSON.
 *
 * `HostConfig.Binds` is not a list of host paths, whatever the field name
 * suggests: Podman reports a named volume in the same position and the same
 * shape as a directory, so `pg-data:/var/lib/postgresql/data:rw` and
 * `/srv/data:/data:rw` arrive indistinguishable. What separates them is
 * `isHostPathSource`, and applying it is `singleMountIntents`' job — the source
 * is recorded verbatim here so the row says what the container actually mounts.
 *
 * That matters most for a named volume. Its name is the only thing tying the
 * adopted application to the data it already holds, so it is carried across
 * untouched rather than turned into a path or renamed into Rudder's namespace.
 */
export function volumesFromContainer(inspect: ContainerInspect): string | null {
  const binds = ((inspect as any).HostConfig?.Binds ?? []).map((bind: string) => {
    const [source, containerPath, mode = 'rw'] = bind.split(':');
    return { hostPath: source, containerPath, mode, volumeId: null };
  });
  return binds.length > 0 ? JSON.stringify(binds) : null;
}

export function restartPolicyFromContainer(
  inspect: ContainerInspect,
): 'no' | 'on-failure' | 'always' | 'unless-stopped' {
  const name = (inspect as any).HostConfig?.RestartPolicy?.Name;
  return name === 'always' || name === 'on-failure' || name === 'unless-stopped' ? name : 'no';
}

/**
 * Candidates for adoption on a worker.
 *
 * Read-only. A container is a candidate when Rudder has no `containers` row for
 * it and it is not platform infrastructure.
 *
 * Note what is *not* a filter: the old code required a Traefik router label
 * before it would consider a container an application, which silently excluded
 * every worker-internal service — a database, a queue, a cache — precisely the
 * things an operator most wants Rudder to start managing.
 */
export async function listAdoptableContainers(workerId: string): Promise<AdoptableContainer[]> {
  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) throw new Error(`Worker ${workerId} not found`);

  const rows = await db
    .select({ containerId: containers.containerId, name: containers.name })
    .from(containers)
    .where(eq(containers.workerId, workerId))
    .all();
  const knownIds = new Set(rows.map((r) => r.containerId));
  const knownNames = new Set(rows.map((r) => podmanName(r.name)));

  const knownTeams = new Set((await db.select({ id: teams.id }).from(teams).all()).map((t) => t.id));

  const client = getRestPodmanClient(worker);
  try {
    const all = await client.listContainers(true);
    const candidates: AdoptableContainer[] = [];

    for (const container of all) {
      if (isInfrastructureContainer(container)) continue;
      const name = podmanName(container.Names?.[0]);
      if (knownIds.has(container.Id) || knownNames.has(name)) continue;

      const labelledTeam = container.Labels?.['rudder.team.id'];
      candidates.push({
        containerId: container.Id,
        name,
        image: container.Image,
        status: container.State,
        domain: routedDomain(container.Labels),
        suggestedName: proposedAppName(name, container.Labels),
        suggestedTeamId: labelledTeam && knownTeams.has(labelledTeam) ? labelledTeam : null,
      });
    }
    return candidates;
  } finally {
    client.destroy();
  }
}

/** One container an operator has decided to adopt. */
export interface AdoptRequest {
  containerId: string;
  /** Application name. Falls back to the proposal in the listing. */
  name?: string;
  teamId?: string | null;
  /** Hostname. Falls back to whatever the container's own router already serves. */
  domain?: string | null;
}

export interface AdoptResult {
  adopted: Array<{ containerId: string; applicationId: string; name: string }>;
  skipped: Array<{ containerId: string; reason: string }>;
}

/**
 * Adopt exactly the containers named, and nothing else.
 *
 * Every write here is attributable to an operator naming a container id. There is
 * no path that walks a worker and decides for itself, which is the difference
 * between this and what it replaced.
 *
 * The deployment row it records is marked `succeeded` because the container is
 * already running — but its manifest is the image reference, which is what
 * Rudder now genuinely knows about the application. The old code wrote the same
 * kind of row while claiming a configuration it had reverse-engineered.
 */
export async function adoptContainers(
  workerId: string,
  requests: readonly AdoptRequest[],
  userId: string | null,
): Promise<AdoptResult> {
  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) throw new Error(`Worker ${workerId} not found`);

  const result: AdoptResult = { adopted: [], skipped: [] };
  if (requests.length === 0) return result;

  const client = getRestPodmanClient(worker);
  try {
    for (const request of requests) {
      try {
        const existing = await db
          .select({ id: containers.id })
          .from(containers)
          .where(
            and(eq(containers.workerId, workerId), eq(containers.containerId, request.containerId)),
          )
          .get();
        if (existing) {
          result.skipped.push({
            containerId: request.containerId,
            reason: 'Already managed by Rudder',
          });
          continue;
        }

        const inspect = await client.getContainer(request.containerId);
        const name = podmanName(inspect.Name);
        const appName = (request.name ?? proposedAppName(name, inspect.Config?.Labels)).trim();
        if (!appName) {
          result.skipped.push({ containerId: request.containerId, reason: 'No application name' });
          continue;
        }

        const nameTaken = await db
          .select({ id: applications.id })
          .from(applications)
          .where(and(eq(applications.name, appName), eq(applications.workerId, workerId)))
          .get();
        if (nameTaken) {
          result.skipped.push({
            containerId: request.containerId,
            reason: `An application named "${appName}" already exists on this worker`,
          });
          continue;
        }

        const applicationId = crypto.randomUUID();
        const now = new Date();
        const image = inspect.Config?.Image ?? 'unknown';
        const domain = request.domain ?? routedDomain(inspect.Config?.Labels);

        // Adoption is the one write site that did not go through
        // `assertDomainAvailable`, so it had neither the format check nor the
        // uniqueness one. Both matter here: the hostname is either typed by the
        // operator or parsed back out of a `Host()` rule on a container Rudder
        // did not create, and it goes straight back into a router rule at the
        // first deploy. A duplicate would give Traefik two routers with the
        // same rule.
        const domainRejected = domain ? await assertDomainAvailable(domain) : null;
        if (domainRejected) {
          result.skipped.push({ containerId: request.containerId, reason: domainRejected });
          continue;
        }

        await db.insert(applications).values({
          id: applicationId,
          teamId: request.teamId ?? null,
          workerId,
          name: appName,
          description: `Adopted from existing container ${name}`,
          domain,
          type: 'single',
          deploymentFormat: 'compose',
          manifest: image,
          environment: environmentFromContainer(inspect),
          volumes: volumesFromContainer(inspect),
          restartPolicy: restartPolicyFromContainer(inspect),
          // Left for the operator. An OIDC client secret and session key only
          // ever existed in the container's labels, and a half-recovered auth
          // configuration is worse than an empty one: it looks configured.
          rateLimitAvg: null,
          rateLimitBurst: null,
          authType: 'none',
          authConfig: null,
          replicas: 1,
          gitRepo: null,
          gitBranch: null,
          gitDockerfile: null,
          healthcheck: null,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });

        const deploymentId = crypto.randomUUID();
        await db.insert(deployments).values({
          id: deploymentId,
          applicationId,
          version: 1,
          manifest: image,
          environment: environmentFromContainer(inspect),
          volumes: volumesFromContainer(inspect),
          image,
          status: 'succeeded',
          deployedBy: userId,
          notes: JSON.stringify([
            'Adopted from a container Rudder did not deploy. It does not carry ' +
              'Rudder’s ownership label, because Podman fixes labels at creation — ' +
              'the next deploy adds it.',
          ]),
          createdAt: now,
          finishedAt: now,
        });

        await db.insert(containers).values({
          id: crypto.randomUUID(),
          applicationId,
          workerId,
          containerId: inspect.Id,
          name,
          image,
          status: inspect.State?.Status ?? 'unknown',
          domain,
          labels: JSON.stringify(redactSecretLabels(inspect.Config?.Labels ?? {})),
          deploymentId,
          // Null on purpose. Rudder did not build this container and cannot say
          // what intent produced it, so the reconciler must never call it stale.
          specHash: null,
          createdAt: now,
          updatedAt: now,
        });

        result.adopted.push({ containerId: request.containerId, applicationId, name: appName });
        console.log(`[adopt] ${appName} adopted from container ${name} on ${worker.name}`);
      } catch (e: any) {
        result.skipped.push({
          containerId: request.containerId,
          reason: e?.message ?? String(e),
        });
      }
    }
    return result;
  } finally {
    client.destroy();
  }
}
