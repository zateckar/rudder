/**
 * Reading and lifting the CrowdSec decisions on a worker.
 *
 * The LAPI listens on 127.0.0.1 on the worker and the control plane has no route
 * to it — but it does have an authenticated, mTLS-protected Podman API, and
 * running `cscli` inside the container is what an operator would do over SSH
 * anyway. So that is the transport.
 */

/** One row of `cscli decisions list -o json`, reduced to what the tab shows. */
export interface CrowdsecDecision {
  /** `cscli decisions delete --id` takes this. */
  id: number;
  /** `crowdsec`, `cscli`, `CAPI`… — who decided. */
  source: string;
  /** `Ip`, `Range`, `Country`… */
  scope: string;
  value: string;
  /** The scenario that fired, e.g. `crowdsecurity/http-probing`. */
  reason: string;
  /** `ban`, `captcha`… */
  type: string;
  duration: string;
}

/**
 * `cscli decisions list -o json` output as decisions, or null for no answer.
 *
 * **Null and `[]` are different facts and must stay so.** The CrowdSec tab used
 * to report an empty list unconditionally, which it rendered as "No active
 * decisions — all clear"; a worker with three live bans, one of them on the
 * operator reading the page, reported itself clear. An empty list is an answer
 * meaning none. Null is no answer, and the page has to say that instead.
 */
export function parseDecisions(stdout: string, exitCode: number): CrowdsecDecision[] | null {
  if (exitCode !== 0) return null;

  // `cscli` prints the JSON literal `null` when there is nothing to report,
  // which is a successful answer meaning "none" — not a failure to answer.
  const text = stdout.trim();
  if (text === '' || text === 'null') return [];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;

    // A row missing fields still renders, because a decision that displays
    // oddly is one somebody nonetheless has to see.
    return parsed.map((d: any) => ({
      id: Number(d?.id ?? 0),
      source: String(d?.origin ?? ''),
      scope: String(d?.scope ?? ''),
      value: String(d?.value ?? ''),
      reason: String(d?.scenario ?? ''),
      type: String(d?.type ?? ''),
      duration: String(d?.duration ?? ''),
    }));
  } catch {
    return null;
  }
}

/** The CrowdSec container on this worker, or null. */
export async function findCrowdsecContainer(client: {
  listContainers: (all: boolean) => Promise<any[]>;
}): Promise<any | null> {
  const all = await client.listContainers(true);
  return (
    all.find(
      (c: any) =>
        c.Names?.includes('/crowdsec') || c.Names?.some((n: string) => n.includes('crowdsec')),
    ) ?? null
  );
}
