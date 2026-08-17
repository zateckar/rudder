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
import type { applications, containers, stacks, teams, workers } from '$lib/db/schema';
import type { Container, PodmanClient } from './podman';
import { buildDeploymentPlan } from './deploy/build';
import { ManifestError, type PlanContext, type PlannedContainer } from './deploy/plan';
import { parseGenerationalName } from './generations';
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

// ── Observed state ───────────────────────────────────────────────────────────

/**
 * Every container on the worker, as Podman reports it.
 *
 * Deliberately *not* filtered to managed containers. The `foreign`
 * classification — present, unmanaged, report only, never touch — is the whole
 * mechanism protecting a co-tenant's workload, and it cannot be produced from a
 * list that has already dropped everything unmanaged. Filtering happens in the
 * diff, where the decision is visible.
 *
 * One call per worker per pass. `all: true` includes stopped containers, which
 * matters: a container that exited is drift, and a list of running ones would
 * report it as missing instead — a different remedy.
 */
export async function observedState(client: PodmanClient): Promise<ObservedContainer[]> {
  const raw = await client.listContainers(true);
  return raw.map(toObserved);
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export type DriftKind = 'missing' | 'stale' | 'unhealthy' | 'orphan' | 'foreign';

export interface DriftEntry {
  kind: DriftKind;
  /** The application concerned, when one is known. Null for a foreign container. */
  appId: string | null;
  appName: string | null;
  /** Desired name for `missing`; the observed Podman name otherwise. */
  name: string;
  /** Podman id. Absent for `missing`, which is about something that is not there. */
  containerId?: string;
  /** What to tell the operator. One sentence, naming the thing and the reason. */
  detail: string;
}

/** An application whose intent could not be computed, and why. */
export interface UnreconcilableApp {
  appId: string;
  appName: string;
  message: string;
}

export interface DiffInput {
  /** Intent, one entry per application on this worker whose manifest parsed. */
  desired: readonly DesiredApp[];
  /** `containers` rows for this worker — what Rudder believes it created. */
  rows: readonly (typeof containers.$inferSelect)[];
  observed: readonly ObservedContainer[];
  /**
   * Every application assigned to this worker, whether or not its intent could
   * be computed.
   *
   * Separate from `desired` on purpose, and the separation is load-bearing. An
   * application whose manifest stops parsing is absent from `desired`; if orphan
   * detection worked off `desired` alone, that application's perfectly healthy
   * containers would all be proposed for deletion. A parse error must never
   * become a reason to destroy something.
   */
  knownAppIds: ReadonlySet<string>;
}

export interface DiffResult {
  drift: DriftEntry[];
  /** True when nothing anywhere disagrees. */
  clean: boolean;
}

/**
 * Classify every difference between intent and reality. Pure.
 *
 * Nothing here decides anything or touches a worker — it returns the
 * classification as data so the dangerous part downstream stays small enough to
 * read in one sitting.
 *
 * The five kinds, and what each actually means:
 *
 * - `missing`   — intent says run it, and it is not running. Either a deploy
 *                 failed partway through its containers, or something removed it.
 * - `stale`     — running, but built from different intent. Needs a new
 *                 generation, which means a deploy; it cannot be patched in place.
 * - `unhealthy` — running and failing its own health check.
 * - `orphan`    — Rudder's label, but Rudder is not tracking it. Removal
 *                 candidate, never removed without a human saying so.
 * - `foreign`   — not Rudder's. Reported so the operator can see it, and
 *                 otherwise left alone forever.
 */
export function diff(input: DiffInput): DiffResult {
  const { desired, rows, observed, knownAppIds } = input;
  const drift: DriftEntry[] = [];

  const observedById = new Map(observed.map((c) => [c.id, c]));
  /** Container ids Rudder has a row for, so an orphan check can exclude them. */
  const trackedIds = new Set(rows.map((r) => r.containerId));
  const trackedNames = new Set(rows.map((r) => r.name));

  for (const app of desired) {
    // Only the generation that is supposed to be serving. A `draining` row is a
    // superseded generation being retained for a fast rollback: present on the
    // worker by design, and absent from intent by design.
    const live = rows.filter(
      (r) => r.applicationId === app.appId && (r.state === 'active' || r.state === 'pending'),
    );
    const claimed = new Set<string>();

    for (const want of app.containers) {
      const row = matchRow(live, want.name, claimed);
      if (!row) {
        drift.push({
          kind: 'missing',
          appId: app.appId,
          appName: app.appName,
          name: want.name,
          detail: `No container recorded for '${want.key}'. A deploy may have failed partway through.`,
        });
        continue;
      }
      claimed.add(row.id);

      const container = observedById.get(row.containerId);
      if (!container) {
        drift.push({
          kind: 'missing',
          appId: app.appId,
          appName: app.appName,
          name: row.name,
          detail: `Container '${row.name}' is recorded but not present on the worker.`,
        });
        continue;
      }

      // A null hash is a container deployed before the column existed, or one
      // adopted from a worker. Rudder does not know what intent built it, and
      // guessing that unknown means stale would propose rebuilding the fleet on
      // the first pass after an upgrade.
      if (row.specHash && row.specHash !== want.specHash) {
        drift.push({
          kind: 'stale',
          appId: app.appId,
          appName: app.appName,
          name: row.name,
          containerId: container.id,
          detail: `Container '${row.name}' was built from different configuration. A deploy will replace it.`,
        });
      }

      if (container.health === 'unhealthy') {
        drift.push({
          kind: 'unhealthy',
          appId: app.appId,
          appName: app.appName,
          name: row.name,
          containerId: container.id,
          detail: `Container '${row.name}' is failing its health check (${container.status}).`,
        });
      } else if (container.state !== 'running') {
        drift.push({
          kind: 'missing',
          appId: app.appId,
          appName: app.appName,
          name: row.name,
          containerId: container.id,
          detail: `Container '${row.name}' is present but ${container.state} (${container.status}).`,
        });
      }
    }
  }

  for (const container of observed) {
    if (!mayRemove(container)) {
      drift.push({
        kind: 'foreign',
        appId: null,
        appName: null,
        name: container.name,
        containerId: container.id,
        detail: `Container '${container.name}' is not managed by Rudder. Reported only; it will never be modified.`,
      });
      continue;
    }

    if (trackedIds.has(container.id) || trackedNames.has(container.name)) continue;

    const claimsApp = ownedAppId(container);
    drift.push({
      kind: 'orphan',
      appId: claimsApp,
      appName: container.labels.app ?? null,
      name: container.name,
      containerId: container.id,
      detail:
        claimsApp && knownAppIds.has(claimsApp)
          ? `Container '${container.name}' carries Rudder's label for an application that exists, but Rudder has no record of it.`
          : `Container '${container.name}' belongs to an application that no longer exists.`,
    });
  }

  return { drift, clean: drift.every((d) => d.kind === 'foreign') };
}

/**
 * Find the row for a desired container name.
 *
 * Exact match first. Blue/green suffixes the Podman name with the generation, so
 * the second attempt strips that — but only as a fallback, because a compose
 * service legitimately called `g2` produces a name the suffix pattern also
 * matches, and the exact comparison gets that right.
 */
function matchRow(
  live: readonly (typeof containers.$inferSelect)[],
  wantName: string,
  claimed: ReadonlySet<string>,
): (typeof containers.$inferSelect) | undefined {
  const free = live.filter((r) => !claimed.has(r.id));
  return (
    free.find((r) => r.name === wantName) ??
    free.find((r) => parseGenerationalName(r.name)?.base === wantName)
  );
}
