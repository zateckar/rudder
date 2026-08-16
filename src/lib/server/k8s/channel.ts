/**
 * The `vN.channel.k8s.io` WebSocket framing that `kubectl exec` speaks.
 *
 * Every frame is binary and begins with one channel byte. There is no length
 * prefix and no message envelope — the channel byte is the entire protocol,
 * which is why getting it slightly wrong produces a session that connects and
 * then shows nothing.
 *
 * Pure functions, no sockets: the framing is what breaks, so it is what gets
 * tested.
 */

export const CHANNEL = {
  STDIN: 0,
  STDOUT: 1,
  STDERR: 2,
  /** Server → client. Carries a v1.Status when the command finishes. */
  ERROR: 3,
  /** Client → server. `{"Width":N,"Height":N}`. */
  RESIZE: 4,
  /** v5 only. Client or server signals that a stream is done. */
  CLOSE: 255,
} as const;

/**
 * Subprotocols this server implements, most preferred first.
 *
 * v4 and v5 share the framing above; v5 adds the CLOSE channel, which is
 * additive — a v5 client that never sends one behaves exactly like v4. kubectl
 * 1.29+ offers v5 first and older clients offer v4, so accepting both covers
 * every version that speaks WebSocket at all. Clients older than that use
 * SPDY, which is a different transport and is not supported.
 */
export const SUPPORTED_PROTOCOLS = ['v5.channel.k8s.io', 'v4.channel.k8s.io'];

/**
 * Choose a subprotocol from the client's offer.
 *
 * Returns false when nothing matches, which makes `ws` complete the handshake
 * without a subprotocol header — kubectl then fails fast with a clear protocol
 * error rather than hanging on a stream it cannot parse.
 */
export function selectChannelProtocol(offered: Set<string> | string[]): string | false {
  const set = offered instanceof Set ? offered : new Set(offered);
  for (const candidate of SUPPORTED_PROTOCOLS) {
    if (set.has(candidate)) return candidate;
  }
  return false;
}

/** Prefix a payload with its channel byte. */
export function frame(channel: number, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from([channel]), body]);
}

export interface ParsedFrame {
  channel: number;
  payload: Buffer;
}

/**
 * Split an incoming frame into channel and payload.
 *
 * An empty frame is not an error on the wire — kubectl sends zero-length
 * keepalives on the stdin channel — but it carries no channel byte, so it is
 * reported as null and dropped rather than being read as channel 0 with the
 * next byte of nothing.
 */
export function parseFrame(data: Buffer | ArrayBuffer | string): ParsedFrame | null {
  const buf = Buffer.isBuffer(data)
    ? data
    : typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(new Uint8Array(data));

  if (buf.length === 0) return null;
  return { channel: buf[0], payload: buf.subarray(1) };
}

/** Terminal dimensions from a RESIZE frame, or null if it is not usable. */
export function parseResize(payload: Buffer): { width: number; height: number } | null {
  try {
    const parsed = JSON.parse(payload.toString('utf8'));
    const width = Number(parsed.Width ?? parsed.width);
    const height = Number(parsed.Height ?? parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width: Math.floor(width), height: Math.floor(height) };
  } catch {
    return null;
  }
}

/**
 * The v1.Status kubectl reads off the error channel to decide its own exit
 * code. Success must be sent too: without it kubectl reports the session as
 * failed even when the command ran fine.
 */
export function statusFrame(exitCode: number, command: string[]): Buffer {
  const status =
    exitCode === 0
      ? { status: 'Success' }
      : {
          status: 'Failure',
          message: `command terminated with non-zero exit code: error executing command ${JSON.stringify(command)}, exit code ${exitCode}`,
          reason: 'NonZeroExitCode',
          details: {
            causes: [
              { reason: 'ExitCode', message: String(exitCode) },
            ],
          },
        };

  return frame(CHANNEL.ERROR, JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    ...status,
  }));
}
