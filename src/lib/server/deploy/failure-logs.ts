/**
 * The container output a failed deploy leaves behind.
 *
 * When a blue/green deploy cannot verify its new generation it removes it —
 * that is the whole point, the previous version is still serving and nothing
 * broken is allowed to keep resources. But the removal takes the only copy of
 * *why* it failed with it: the container is gone, its row is deleted, and
 * `/api/containers/logs` needs both. So the deploy reported
 *
 *     Container 'x-g1' is restarting (1 restarts) rather than staying up.
 *     Check its logs for why it exits.
 *
 * and then there were no logs to check, anywhere. The only way to read them was
 * to be watching `podman logs` on the worker at the moment it happened.
 *
 * This captures the tail of each container's output at the moment the deploy
 * fails, before anything is discarded, and stores it on the deployment row where
 * the failure is already recorded. It is a snapshot, not a log stream: a few
 * hundred lines, kept with the deployment that produced them.
 *
 * Everything here is pure or takes the one Podman call it needs as an interface,
 * the same way `verifyGeneration` does — so the format and the capture are
 * tested without a worker.
 */
import { REDACTED } from '$lib/server/redaction';

/** How many lines of a failed container's output are worth keeping. */
export const FAILURE_LOG_TAIL_LINES = 200;

/**
 * Ceiling per container, in characters.
 *
 * A container that fails by printing a stack trace on every restart can produce
 * a great deal of output in the few seconds verification gives it, and this
 * lands in a row that is read back into a modal. The *end* is what explains the
 * exit, so the cap keeps the tail and says what it dropped.
 */
export const FAILURE_LOG_MAX_CHARS = 8_000;

/** One container's output, as stored on the deployment row. */
export interface CapturedOutput {
  /** Podman's container name — what the failure message names. */
  container: string;
  /** Tail of stdout and stderr, interleaved. Empty when it printed nothing. */
  log: string;
  /**
   * Why the output could not be read, when it could not.
   *
   * Distinct from an empty `log`: "it printed nothing" and "the worker would not
   * tell us" are different answers, and the second one is about the worker
   * rather than about the application.
   */
  unavailable?: string;
}

/** The one Podman call a capture makes. See `VerificationSource` in deploy.ts. */
export interface LogSource {
  getContainerLogs(
    id: string,
    options: { stdout?: boolean; stderr?: boolean; tail?: number; timestamps?: boolean },
  ): Promise<string>;
}

/** Enough of a created container to read its logs and name it. */
export interface LoggableContainer {
  containerId: string;
  name: string;
}

/**
 * Keep the last `max` characters, marking what was dropped.
 *
 * Truncating from the front rather than the back because a crash is at the end
 * of the output, never at the beginning.
 */
export function tailChars(text: string, max: number = FAILURE_LOG_MAX_CHARS): string {
  if (text.length <= max) return text;
  const kept = text.slice(text.length - max);
  // Resume at a line boundary so the first line shown is a whole one.
  const nl = kept.indexOf('\n');
  const body = nl === -1 ? kept : kept.slice(nl + 1);
  return `[… ${text.length - body.length} earlier characters dropped]\n${body}`;
}

/**
 * Replace secret values wherever they appear in captured output.
 *
 * An application that prints its configuration at startup — which is exactly the
 * kind of application that then fails to start — puts the values Rudder injected
 * into its own log. Storing that verbatim would copy every secret bound to the
 * application into the deployment history in plaintext, next to the encrypted
 * originals in the secrets store. The same objection that redacted container
 * labels applies here, and more directly.
 *
 * Matched literally, not by pattern: these are the values Rudder itself
 * injected, so there is no guessing about which strings are sensitive. Very
 * short values are skipped — a two-character secret would redact half the log
 * and tell an attacker nothing they did not already have.
 */
export function maskSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (!value || value.length < 4) continue;
    // split/join rather than a RegExp: a secret is arbitrary bytes and may well
    // contain characters that would otherwise be read as a pattern.
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

/**
 * Read the tail of every container's output, best-effort.
 *
 * Never throws. This runs while a deploy is already failing, and a second
 * failure here must not replace the first — the original error is the one that
 * explains what went wrong, and losing it to "could not read logs" would be a
 * strictly worse outcome than the silence this replaces.
 */
export async function captureContainerOutput(
  source: LogSource,
  containers: readonly LoggableContainer[],
  options: { mask?: readonly string[] } = {},
): Promise<CapturedOutput[]> {
  const captured: CapturedOutput[] = [];

  for (const c of containers) {
    try {
      const raw = await source.getContainerLogs(c.containerId, {
        stdout: true,
        stderr: true,
        tail: FAILURE_LOG_TAIL_LINES,
        // Timestamps, because the question being answered is usually "did it
        // print this once, or on every restart?".
        timestamps: true,
      });
      captured.push({
        container: c.name,
        log: tailChars(maskSecretValues(raw, options.mask ?? [])).trimEnd(),
      });
    } catch (e: any) {
      captured.push({
        container: c.name,
        log: '',
        unavailable: e?.message ?? String(e),
      });
    }
  }

  return captured;
}

/**
 * Render captured output for storage, or null when there is nothing to store.
 *
 * Null rather than `[]` so a deployment that recorded no output is
 * indistinguishable from one deployed before this column existed — both mean
 * "there is nothing here to show", and the UI has one case to handle.
 */
export function serializeCapturedOutput(captured: readonly CapturedOutput[]): string | null {
  const useful = captured.filter((c) => c.log !== '' || c.unavailable);
  return useful.length > 0 ? JSON.stringify(useful) : null;
}

/** Read the column back, tolerating rows written before it existed. */
export function parseCapturedOutput(raw: string | null | undefined): CapturedOutput[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c: any) => c && typeof c.container === 'string' && typeof c.log === 'string',
      )
      .map((c: any) => ({
        container: c.container,
        log: c.log,
        ...(typeof c.unavailable === 'string' ? { unavailable: c.unavailable } : {}),
      }));
  } catch {
    // Malformed record: treated as no output at all, never as a failure to read
    // the deployment history it is attached to.
    return [];
  }
}
