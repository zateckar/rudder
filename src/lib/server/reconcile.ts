/**
 * Reconciliation: what should be running, what is running, and the difference.
 *
 * Everything before this closed no loop. A deploy pushed containers onto a
 * worker and stopped caring; if one died, or someone removed it by hand, or a
 * deploy failed halfway through its containers, nothing noticed. Drift was
 * discovered by a human looking at a dashboard, or archaeologically, by
 * `app-discovery` reverse-engineering containers back into application records.
 *
 * The three pieces here are deliberately separated by how dangerous they are:
 *
 *   `desiredState`  — pure. Database rows in, intent out.
 *   `observedState` — reads the Podman API. Reads only.
 *   `diff`          — pure. Classifies each difference as data.
 *
 * Deciding and acting is the only part that can destroy anything, and it is
 * kept to the smallest reviewable surface: one function, gated on `apply`,
 * which defaults to false everywhere.
 *
 * ## The ownership rule
 *
 * **A container may only be stopped or removed if it carries
 * `rudder.managed=true`.** Workers are not necessarily single-tenant. A
 * reconciler that garbage-collects containers it does not recognise would
 * destroy a co-tenant's workload the first time it ran, and the co-tenant would
 * have done nothing wrong. `mayRemove` is the single place that decision is
 * made, and every path that could destroy something goes through it.
 *
 * The rule is enforced on the label, not on the presence of a `containers` row,
 * because the label is what travels with the thing being destroyed. A row can be
 * stale, or point at a container id that has since been reused; the label is on
 * the object itself.
 *
 * That has one consequence worth stating plainly: **ownership cannot be
 * backfilled.** Podman fixes a container's labels at creation and offers no way
 * to add one afterwards — `podman container update` does not touch them. So
 * containers deployed before the label became unconditional classify as
 * `foreign` and are reported, never acted on. They pick up the label the next
 * time their application is deployed. This is the safe direction to fail in: the
 * reconciler under-claims rather than over-claims.
 */
import { createHash } from 'crypto';
import type { applications, stacks, teams, workers } from '$lib/db/schema';
import type { Container } from './podman';
import { buildDeploymentPlan } from './deploy/build';
import { ManifestError, type PlanContext, type PlannedContainer } from './deploy/plan';
import type { PortAllocator } from './ports';
import { singleMountIntents } from './volumes';

export const MANAGED_LABEL = 'rudder.managed';
export const APP_ID_LABEL = 'rudder.app.id';

/** A container as the Podman API reports it, reduced to what reconciliation uses. */
export interface ObservedContainer {
  /** Podman container id. */
  id: string;
  /** Podman name, with the leading slash the API sometimes adds removed. */
  name: string;
  image: string;
  /** `running`, `exited`, `created`, … */
  state: string;
  /** Podman's human status string, e.g. `Up 3 hours (healthy)`. */
  status: string;
  /** Parsed out of `status`; null when the container declares no health check. */
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  labels: Record<string, string>;
  /** Host ports this container publishes. */
  hostPorts: number[];
}

/**
 * Whether Rudder is permitted to destroy this container.
 *
 * The single ownership decision in the system. Keep it that way: a second copy
 * of this test is a second chance to get it wrong, and the cost of getting it
 * wrong is someone else's production workload.
 */
export function mayRemove(container: { labels: Record<string, string> }): boolean {
  return container.labels?.[MANAGED_LABEL] === 'true';
}

/** The application a managed container belongs to, or null if it claims none. */
export function ownedAppId(container: { labels: Record<string, string> }): string | null {
  if (!mayRemove(container)) return null;
  const id = container.labels?.[APP_ID_LABEL];
  return id && id.length > 0 ? id : null;
}

/**
 * Filter a set of removal wishes down to the ones that are actually permitted.
 *
 * Callers do not get to skip this. `reconcile` never calls the Podman removal
 * endpoint with anything that did not come out of here, and the returned list is
 * what gets shown to the operator for confirmation — so what is displayed and
 * what could be destroyed are the same set.
 */
export function permittedRemovals<T extends { labels: Record<string, string> }>(
  wanted: readonly T[],
): T[] {
  return wanted.filter(mayRemove);
}

// ── Podman shapes ────────────────────────────────────────────────────────────

/** Strip the leading slash the compat API puts on container names. */
export function podmanName(raw: string | undefined): string {
  return (raw ?? '').replace(/^\//, '');
}

/**
 * Health as Podman reports it in the status string.
 *
 * `/containers/json` does not carry a structured health field — only
 * `Up 2 minutes (healthy)`. Inspecting every container to get `State.Health`
 * would be one API round trip per container per cycle, on every worker, to learn
 * something the list response already contains.
 */
export function healthFromStatus(status: string | undefined): ObservedContainer['health'] {
  if (!status) return null;
  if (/\(healthy\)/i.test(status)) return 'healthy';
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy';
  if (/\(health: starting\)|\(starting\)/i.test(status)) return 'starting';
  return null;
}

/** Reduce a Podman list entry to the fields reconciliation compares. */
export function toObserved(raw: Container): ObservedContainer {
  const hostPorts: number[] = [];
  for (const p of raw.Ports ?? []) {
    if (typeof p?.PublicPort === 'number' && p.PublicPort > 0) hostPorts.push(p.PublicPort);
  }
  return {
    id: raw.Id,
    name: podmanName(raw.Names?.[0]),
    image: raw.Image,
    state: raw.State,
    status: raw.Status,
    health: healthFromStatus(raw.Status),
    labels: raw.Labels ?? {},
    hostPorts,
  };
}

// ── Spec hash ────────────────────────────────────────────────────────────────

/**
 * Hash the parts of a container's intent that can only be changed by recreating
 * it.
 *
 * What is *not* in here matters more than what is. Routing — the domain, the
 * router name, the host port, the Traefik labels, the middleware chain, the rate
 * limit, the auth mode — is all excluded, because a worker in `http` routing mode
 * fetches that from the control plane on a five-second poll. Including it would
 * make every rate-limit edit look like a container that needs replacing, which
 * is the redeploy 2-02 existed to abolish.
 *
 * Host ports are excluded for a second, harder reason: they are drawn from an
 * allocator, so recomputing the plan for an unchanged application yields
 * different numbers. A hash containing them would report the whole fleet stale on
 * every pass.
 *
 * `files` is included by content. A changed config file cannot be delivered to a
 * running container — the archive upload happens between create and start — so a
 * change there does require a new generation.
 *
 * One known gap, stated rather than hidden: this hashes the *planned* container,
 * and the executor merges resolved secrets into the environment after planning.
 * Rotating a secret delivered as an environment variable therefore does not make
 * its containers read as stale. Rotation already requires a redeploy for the new
 * value to reach the process, so nothing regresses — but the reconciler will not
 * notice on its own, and should not be relied on to.
 */
export function specHash(planned: PlannedContainer): string {
  const canonical = {
    image: planned.image,
    entrypoint: planned.entrypoint ?? null,
    command: planned.command ?? null,
    workingDir: planned.workingDir ?? null,
    // Order preserved. Podman resolves a repeated variable to its last
    // occurrence, so a reorder can change the effective environment; sorting
    // here would hash two genuinely different environments identically.
    env: planned.env,
    // Sorted, because declaration order of storage has no effect on the
    // container, and the key order within each intent is normalised so an object
    // built field-by-field in a different order does not read as a change.
    mounts: [...planned.mounts]
      .map((m) => JSON.stringify(m, Object.keys(m).sort()))
      .sort(),
    // Identity and user labels only — the executor's Traefik labels are not in
    // `planned.labels`, which is what keeps routing out of this hash. An
    // application rename or a move between teams lands here, and both do need
    // the container rebuilt.
    labels: Object.keys(planned.labels)
      .sort()
      .map((k) => `${k}=${planned.labels[k]}`),
    aliases: [...planned.aliases].sort(),
    restartPolicy: planned.restartPolicy,
    memory: planned.memory ?? null,
    cpuQuota: planned.cpuQuota ?? null,
    cpuPeriod: planned.cpuPeriod ?? null,
    healthcheck: planned.healthcheck ?? null,
    files: (planned.files ?? [])
      .map((f) => `${f.dir}/${f.name}:${f.mode ?? 0o644}:${sha256(f.content)}`)
      .sort(),
  };
  return sha256(JSON.stringify(canonical));
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ── Desired state ────────────────────────────────────────────────────────────

/**
 * Everything `desiredState` needs, all of it already loaded.
 *
 * Rows in, intent out, no database. That is what makes desired state testable
 * against a fixture and — more to the point — comparable without touching a
 * worker. The two things that genuinely require I/O are hoisted out to the
 * caller: the volume registry, and the port allocator.
 */
export interface DesiredStateInput {
  app: typeof applications.$inferSelect;
  worker: typeof workers.$inferSelect;
  team?: Pick<typeof teams.$inferSelect, 'id' | 'name' | 'slug'> | null;
  stack?: Pick<typeof stacks.$inferSelect, 'id' | 'name'> | null;
  /** Registered volumes the application references, keyed by volume id. */
  volumeRegistry?: Map<string, { name: string; containerPath: string }>;
  /**
   * Draws a free host port on the worker. Supplied by a deploy, which is
   * allocating for real; omitted when reconciling, which is only comparing.
   */
  allocatePort?: PortAllocator;
}

export interface DesiredContainer {
  /** Compose service, Kubernetes container, or the application's own name. */
  key: string;
  /** Podman name, before any blue/green generation suffix. */
  name: string;
  planned: PlannedContainer;
  /** @see specHash */
  specHash: string;
}

export interface DesiredApp {
  appId: string;
  appName: string;
  workerId: string;
  containers: DesiredContainer[];
  /** What the manifest asked for that this deployment will not do. */
  notes: string[];
  /**
   * True when no allocator was supplied, so every host port in `planned.ports`
   * and `planned.route` is a placeholder. Reconciliation does not compare ports —
   * they are drawn from an allocator and so differ on every recomputation — but
   * nothing downstream should mistake these for numbers a container will bind.
   */
  portsArePlaceholders: boolean;
}

/**
 * A port number no container will ever be told to bind.
 *
 * Deliberately outside the allocator's 30000–32767 range so a placeholder that
 * escaped into a Podman call would fail loudly on the port rather than quietly
 * bind something plausible.
 */
const PLACEHOLDER_PORT_BASE = 1;

/**
 * What should be running for this application, as a pure function of its rows.
 *
 * This is the same computation a deploy performs, because it *is* the
 * computation a deploy performs: `buildDeploymentPlan` has been the single
 * definition of intent since the three deploy paths were collapsed, and both the
 * deploy and the reconciler reach it through here. Intent with two definitions
 * is intent that will disagree with itself, and the disagreement would surface as
 * a reconciler that wants to rebuild a fleet that is already correct.
 *
 * Throws `ManifestError` for a manifest that cannot be deployed as written. A
 * reconcile pass catches it and reports the application as unreconcilable rather
 * than failing the whole worker: one bad manifest must not blind the operator to
 * drift everywhere else.
 */
export function desiredState(input: DesiredStateInput): DesiredApp {
  const { app, worker, team, stack } = input;
  if (!app.manifest) throw new ManifestError('No manifest found');

  let placeholder = PLACEHOLDER_PORT_BASE;
  const allocatePort = input.allocatePort ?? (() => placeholder++);

  const ctx: PlanContext = {
    appId: app.id,
    appName: app.name,
    appDomain: app.domain,
    baseDomain: process.env.TRAEFIK_BASE_DOMAIN || worker.baseDomain || worker.hostname,
    teamSlug: team?.slug,
    team: team ? { id: team.id, name: team.name } : undefined,
    stack: stack ? { id: stack.id, name: stack.name } : undefined,
    replicas: app.replicas,
    restartPolicy: app.restartPolicy,
    environment: app.environment,
    healthcheck: app.healthcheck,
    gitRepo: app.gitRepo,
    allocatePort,
  };

  const plan = buildDeploymentPlan(
    {
      type: app.type,
      manifest: app.manifest,
      singleMounts: singleMountIntents(app.id, app.volumes, input.volumeRegistry ?? new Map()),
    },
    ctx,
  );

  return {
    appId: app.id,
    appName: app.name,
    workerId: worker.id,
    containers: plan.containers.map((planned) => ({
      key: planned.key,
      name: planned.name,
      planned,
      specHash: specHash(planned),
    })),
    notes: plan.notes,
    portsArePlaceholders: !input.allocatePort,
  };
}
