/**
 * Container generations — the bookkeeping that lets two versions of one
 * application exist at the same time.
 *
 * A deploy used to remove the old containers before creating the new ones. That
 * made every deploy an outage and every failed deploy an incident: the old
 * version was already gone by the time the new one failed to start. Blue/green
 * replaces it — create generation N+1 alongside N, verify it, move traffic,
 * then reap N.
 *
 * The generation is part of the Podman container name because Podman names are
 * unique per host. That single fact is why the old scheme *could not* run two
 * versions at once, and why the suffix is not cosmetic.
 *
 * Everything here is pure so it can be tested without a database or a worker.
 */

/** @see containers.state in the schema for what each value means. */
export type ContainerState = 'pending' | 'active' | 'draining';

/**
 * How often a worker fetches its routing configuration.
 *
 * Must match `OnUnitActiveSec` in
 * `provisioning/shell/units/rudder-traefik-config.timer`. A cutover is not
 * complete until the worker has fetched the configuration that describes it.
 */
export const CONFIG_POLL_INTERVAL_MS = 10_000;

/**
 * Longest a cutover waits for the worker to pick the new configuration up.
 *
 * The wait normally ends early, on observing `workers.config_fetched_at` move
 * past the cutover — this is the ceiling for a worker whose timer is late or
 * whose fetch is failing, not the expected cost.
 */
export const CUTOVER_CONVERGENCE_TIMEOUT_MS = CONFIG_POLL_INTERVAL_MS * 2 + 5_000;

/** How often the cutover wait re-reads `config_fetched_at`. */
export const CONVERGENCE_POLL_MS = 500;

/**
 * Slack between the worker fetching the configuration and Traefik acting on it.
 *
 * The fetch script writes the file and Traefik's file provider watches the
 * directory, so the reload follows within milliseconds — but `config_fetched_at`
 * is stamped when the control plane serves the response, which is strictly
 * before either.
 */
export const TRAEFIK_RELOAD_MARGIN_MS = 1_000;

/**
 * How long the superseded generation keeps running after traffic has moved off
 * it.
 *
 * Traefik has no connection draining of its own: once the routing configuration
 * stops listing a server, new requests go elsewhere, but requests already in
 * flight are still being served by that container. This window is what lets
 * them finish. Stopping the container at cutover would cut them off mid-response.
 */
export const DRAIN_GRACE_MS = 30_000;

/** Deploy default for how long to wait for generation N+1 to become healthy. */
export const DEFAULT_HEALTH_TIMEOUT_S = 120;

/** How often the health wait re-inspects the new containers. */
export const HEALTH_POLL_MS = 1_000;

/**
 * How long a container with no health check must simply stay up before the
 * deploy believes it.
 *
 * Weaker than a health check, and deliberately so — see `verifyGeneration` in
 * deploy.ts for why the control plane cannot probe the port itself.
 */
export const SETTLE_MS = 5_000;

/** Suffix that distinguishes one generation's containers from another's. */
export function generationalName(base: string, generation: number): string {
  return `${base}-g${generation}`;
}

/**
 * Recover the base name and generation from a container name.
 *
 * Returns null for names without the suffix — containers created before
 * generations existed, and containers discovered on a worker that Rudder did
 * not deploy.
 */
export function parseGenerationalName(
  name: string,
): { base: string; generation: number } | null {
  const match = name.match(/^(.*)-g(\d+)$/);
  if (!match || !match[1]) return null;
  return { base: match[1], generation: Number(match[2]) };
}

/**
 * The generation a new deploy should use: one past the highest that exists.
 *
 * Derived from the live containers rather than from a counter, so a generation
 * number is never reused while its containers are still around to collide with
 * — which is the only thing the number has to guarantee.
 */
export function nextGeneration(existing: readonly number[]): number {
  let highest = 0;
  for (const g of existing) {
    if (Number.isFinite(g) && g > highest) highest = g;
  }
  return highest + 1;
}

/**
 * Whether an application's worker can do a blue/green deploy.
 *
 * Only `http` routing mode can. In `labels` mode the routing lives in container
 * labels, so two generations would each define the same Traefik router and
 * service with different backends; Traefik resolves that conflict by dropping
 * the service, taking the application down for the length of the overlap. A
 * labels-mode worker therefore keeps the old destroy-then-create path, and
 * switching it to `http` mode is what turns blue/green on.
 */
export function supportsBlueGreen(worker: { routingMode?: string | null }): boolean {
  return worker.routingMode === 'http';
}

/**
 * Whether the application pins its containers to specific host ports.
 *
 * Two generations cannot both bind the same host port, so an application that
 * asks for one has to keep the destroy-then-create path — honouring the request
 * and reallocating the port silently are both worse than saying so.
 *
 * Only single-container applications can do this. Compose and Kubernetes
 * manifests have their host ports allocated by Rudder regardless of what the
 * file says, because Traefik does the routing and the host port is an
 * implementation detail; multi-replica applications allocate for the same
 * reason.
 */
export function declaresFixedHostPorts(app: {
  type?: string | null;
  replicas?: number | null;
  manifest?: string | null;
}): boolean {
  if (app.type !== 'single') return false;
  if ((app.replicas ?? 1) > 1) return false;
  try {
    const cfg = JSON.parse(app.manifest ?? '');
    return (
      Array.isArray(cfg?.ports) &&
      cfg.ports.some((p: any) => String(p?.hostPort ?? '').trim() !== '')
    );
  } catch {
    // A manifest that is a bare image name declares no ports at all.
    return false;
  }
}

/** Health-check timeout for an application, in milliseconds. */
export function healthTimeoutMs(app: { healthTimeoutSeconds?: number | null }): number {
  const seconds = app.healthTimeoutSeconds;
  if (typeof seconds === 'number' && seconds > 0) return seconds * 1000;
  return DEFAULT_HEALTH_TIMEOUT_S * 1000;
}

/**
 * How many consecutive failed reap attempts before a retained generation stops
 * being retried in silence and starts being reported as drift.
 *
 * The sweep runs on the metrics interval, so a genuinely transient failure — a
 * worker that was briefly unreachable, a volume held open by a helper — clears
 * well inside this. What it is here to catch is the failure that never clears:
 * before this, `reapContainers` logged a warning and tried again on the next
 * cycle, forever, and the only trace was a line on the control plane's stdout.
 * A retry loop that can neither succeed nor complain is indistinguishable from
 * one that is working.
 *
 * Lives here rather than in `deploy.ts` because the reconciler reads it too, and
 * `deploy.ts` already imports from this module — the other direction would be a
 * cycle.
 */
export const REAP_ATTEMPTS_BEFORE_REPORTING = 3;

/** Fast-rollback retention window for an application, in milliseconds. */
export function retentionMs(app: { retainPreviousMinutes?: number | null }): number {
  const minutes = app.retainPreviousMinutes;
  if (typeof minutes === 'number' && minutes > 0) return minutes * 60_000;
  return 0;
}

/**
 * Whether a retained generation has outlived its window and should be reaped.
 *
 * `retainedAt` is the container row's `updated_at`, stamped when it entered
 * `draining`.
 *
 * The drain grace is a floor even when retention is zero. A deploy reaps its
 * own superseded generation directly and never reaches this function, so the
 * floor only ever applies to a generation left draining by something that did
 * not finish — and in that case "how long since traffic moved" is exactly the
 * question, since nothing else is going to answer it.
 */
export function retentionExpired(
  app: { retainPreviousMinutes?: number | null },
  retainedAt: Date,
  now: Date,
): boolean {
  const window = Math.max(retentionMs(app), DRAIN_GRACE_MS);
  return now.getTime() - retainedAt.getTime() >= window;
}
