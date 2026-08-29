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
  /**
   * The **decision** id, which is what `cscli decisions delete --id` takes.
   *
   * Not the alert id. They sit at different levels of the same document and are
   * both called `id`, so reading the outer one produces a plausible number that
   * deletes the wrong thing or nothing at all.
   */
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
  /** Two-letter country of the source address, when CrowdSec resolved one. */
  country: string;
  /** Autonomous system name, e.g. `GOOGLE-CLOUD-PLATFORM`. */
  asName: string;
}

/** Alert-level fields worth carrying down onto each of its decisions. */
function alertContext(alert: any): { scope: string; value: string; country: string; asName: string } {
  const source = alert?.source ?? {};
  return {
    scope: String(source.scope ?? ''),
    value: String(source.value ?? source.ip ?? ''),
    country: String(source.cn ?? ''),
    asName: String(source.as_name ?? ''),
  };
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

    // Despite the command's name, this is a list of *alerts*, each carrying the
    // decisions it produced. `scenario` exists at both levels, which is what made
    // the first version look half-right: Reason filled in while Source, Address,
    // Action and Expiry stayed blank, and the id it read was the alert's rather
    // than the decision's — a plausible number that deletes the wrong row.
    const rows: CrowdsecDecision[] = [];
    for (const alert of parsed) {
      const context = alertContext(alert);
      const nested = Array.isArray(alert?.decisions) ? alert.decisions : null;

      if (nested === null) {
        // Some `cscli` versions, and `-o json` on a decisions-only endpoint,
        // return the decisions flat. Recognised by shape rather than by version
        // so an upgrade cannot quietly empty this table.
        if (alert?.type === undefined && alert?.value === undefined) continue;
        rows.push(decisionRow(alert, context, alert?.scenario));
        continue;
      }

      // An alert with no decisions fired without banning anything: nothing to
      // show here and nothing to lift.
      for (const decision of nested) {
        rows.push(decisionRow(decision, context, alert?.scenario));
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * One decision as a row. Missing fields become blanks rather than dropping the
 * row — a decision that displays oddly is one somebody nonetheless has to see.
 */
function decisionRow(
  d: any,
  context: { scope: string; value: string; country: string; asName: string },
  alertScenario: unknown,
): CrowdsecDecision {
  return {
    id: Number(d?.id ?? 0),
    source: String(d?.origin ?? ''),
    // The decision's own scope/value when it has them; the alert's source
    // otherwise. They agree in practice, and the fallback is what keeps the
    // address column populated if that ever stops being true.
    scope: String(d?.scope ?? context.scope ?? ''),
    value: String(d?.value ?? context.value ?? ''),
    reason: String(d?.scenario ?? alertScenario ?? ''),
    type: String(d?.type ?? ''),
    duration: String(d?.duration ?? ''),
    country: context.country,
    asName: context.asName,
  };
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
