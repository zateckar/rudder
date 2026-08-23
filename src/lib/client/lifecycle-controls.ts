/**
 * Which application-level lifecycle controls to offer, and what to call them.
 *
 * Split out of the application detail page so the rules are assertable. They
 * are easy to get subtly wrong in a way no type catches: counting every
 * generation rather than the one that is serving offers to stop five containers
 * when the endpoint will touch three, and a partially-down application that
 * hides Start is unrecoverable without going container by container — which is
 * the thing these controls exist to avoid.
 *
 * Kept in step with `/api/applications/deploy`, which acts on exactly the
 * `state === 'active'` rows.
 */

/** The two container columns these decisions read. */
export interface LifecycleContainer {
  /** 'active' | 'pending' | 'superseded'. */
  state: string;
  /** Free text from Podman, not an enum — 'running', 'exited', 'missing', … */
  status: string;
}

export interface LifecycleControls {
  /** Containers the application is serving from. What the endpoint will touch. */
  activeCount: number;
  runningCount: number;
  canStart: boolean;
  canStopOrRestart: boolean;
  /**
   * Whether Restart should ask first. One container does not — the per-container
   * Restart button does not either — but several go down together, so every
   * service of a multi-service application is interrupted at the same moment.
   */
  confirmRestart: boolean;
}

export function lifecycleControls(
  containers: readonly LifecycleContainer[],
): LifecycleControls {
  // A superseded generation retained for a fast rollback is deliberately
  // stopped. Restarting it would resurrect the old version's processes with no
  // traffic routed to them, so it is not part of "the application" here.
  const active = containers.filter((c) => c.state === 'active');
  const running = active.filter((c) => c.status === 'running');

  return {
    activeCount: active.length,
    runningCount: running.length,
    // A partially-down application offers all three, which is the state where
    // they matter most.
    canStart: running.length < active.length,
    canStopOrRestart: running.length > 0,
    confirmRestart: active.length > 1,
  };
}

/** "Stop" for one container, "Stop all (3)" for several — "(1)" is noise. */
export function lifecycleLabel(verb: string, activeCount: number): string {
  return activeCount > 1 ? `${verb} all (${activeCount})` : verb;
}
