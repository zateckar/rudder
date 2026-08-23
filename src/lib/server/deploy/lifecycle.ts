/**
 * Applying one lifecycle action to every container of an application.
 *
 * Start, stop and restart are per-container calls on the Podman API, and an
 * application is one container or twenty. The loop that fans them out used to
 * live inline in `/api/applications/deploy` and swallowed every failure into
 * `console.error` before returning `{ success: true }` regardless — so a stop
 * that stopped nothing reported "Application stopped". Nothing surfaced it
 * because no button called those actions; the moment one does, the lie is what
 * the operator reads.
 *
 * The Podman call arrives as `op` rather than a client, the way the plan
 * parsers take an injected `allocatePort` (see plan.ts). That is what makes the
 * accounting testable: a `PodmanRestClient` needs a real worker, and this
 * repository mocks nothing.
 */

/** One container the action did not work on, and what Podman said. */
export interface LifecycleFailure {
  /** The container's name, which is what the operator sees in the UI. */
  name: string;
  message: string;
}

export interface LifecycleOutcome {
  /** Row ids whose operation succeeded — the caller updates their status. */
  succeeded: string[];
  failures: LifecycleFailure[];
}

/** The minimum a container row needs for this to act on it. */
export interface LifecycleTarget {
  id: string;
  name: string;
  containerId: string;
}

/** Past tense, because that is how the result reads back to the operator. */
export type LifecycleVerb = 'started' | 'stopped' | 'restarted';

const INFINITIVE: Record<LifecycleVerb, string> = {
  started: 'start',
  stopped: 'stop',
  restarted: 'restart',
};

/** How many individual failures a message spells out before summarising. */
const MAX_NAMED_FAILURES = 3;

/**
 * Run `op` against every container, and report which ones took it.
 *
 * Sequential, not concurrent: this is the order the manifest asked for —
 * compose honours `depends_on` when building the plan — and starting a
 * dependency and its dependent at the same instant is exactly what that
 * ordering exists to prevent. One failure does not stop the rest; a container
 * that is already gone must not block the four behind it.
 */
export async function applyToContainers(
  rows: readonly LifecycleTarget[],
  op: (containerId: string) => Promise<void>,
): Promise<LifecycleOutcome> {
  const succeeded: string[] = [];
  const failures: LifecycleFailure[] = [];

  for (const row of rows) {
    try {
      await op(row.containerId);
      succeeded.push(row.id);
    } catch (e: any) {
      failures.push({ name: row.name, message: e?.message || 'unknown error' });
    }
  }

  return { succeeded, failures };
}

/** `web: connection refused; db: no such container` — capped, then counted. */
function describeFailures(failures: readonly LifecycleFailure[]): string {
  const named = failures
    .slice(0, MAX_NAMED_FAILURES)
    .map((f) => `${f.name}: ${f.message}`)
    .join('; ');
  const remaining = failures.length - MAX_NAMED_FAILURES;
  return remaining > 0 ? `${named}; and ${remaining} more` : named;
}

/**
 * What to tell the operator.
 *
 * Says the count on purpose. "Application stopped" is the same sentence whether
 * it stopped one container or five of five, and the difference is the whole
 * reason an application-level control exists.
 */
export function lifecycleMessage(
  verb: LifecycleVerb,
  attempted: number,
  outcome: LifecycleOutcome,
): string {
  const infinitive = INFINITIVE[verb];

  if (attempted === 0) {
    return `No active containers — nothing to ${infinitive}.`;
  }

  const done = outcome.succeeded.length;
  const capitalised = verb.charAt(0).toUpperCase() + verb.slice(1);

  if (outcome.failures.length === 0) {
    return attempted === 1
      ? `Application ${verb}.`
      : `Application ${verb} (${attempted} containers).`;
  }

  if (done === 0) {
    const what = attempted === 1 ? 'the container' : `any of the ${attempted} containers`;
    return `Could not ${infinitive} ${what}. ${describeFailures(outcome.failures)}`;
  }

  return `${capitalised} ${done} of ${attempted} containers. ${describeFailures(outcome.failures)}`;
}
