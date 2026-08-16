/**
 * Host port allocation for published containers.
 *
 * Every deployment path — single container, compose, Kubernetes manifest —
 * publishes on a host port Rudder picks, never one the user named. Traefik does
 * the routing, so the host port is an implementation detail, and letting a
 * manifest choose it means two applications that both say `80` cannot run on
 * one worker, and one application cannot run two generations at once.
 */

export const PORT_RANGE_START = 30000;

/**
 * Exclusive upper bound, and it stops at 32768 deliberately: that is the floor
 * of Linux's default `net.ipv4.ip_local_port_range`, so anything above it can
 * be held transiently by an outbound connection from the host. The range used
 * to run to 40000 and overlapped it, and a container would then fail to start
 * with `bind: address already in use` naming a port no container held — a
 * failure that looks like a Podman fault and does not reproduce.
 *
 * Ports already recorded above this bound keep working; they are still counted
 * as reserved, they are simply never handed out again.
 */
export const PORT_RANGE_END = 32768;

/** Pick a free host port, falling back to a linear scan if draws keep colliding. */
export function pickFreePort(taken: Set<number>): number {
  const span = PORT_RANGE_END - PORT_RANGE_START;
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = PORT_RANGE_START + Math.floor(Math.random() * span);
    if (!taken.has(candidate)) return candidate;
  }
  for (let port = PORT_RANGE_START; port < PORT_RANGE_END; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error(
    `No free host port available in range ${PORT_RANGE_START}-${PORT_RANGE_END - 1} on this worker.`,
  );
}

/**
 * The allocator a manifest parser is handed.
 *
 * Parsers take one rather than calling `pickFreePort` themselves, because only
 * the deploy path knows which ports the worker already has in use — and, since
 * blue/green, which ports the generation being replaced is still holding.
 */
export type PortAllocator = () => number;

/**
 * Last-resort allocator for a parser called without one.
 *
 * Only reachable from tests and from callers that parse a manifest to inspect
 * it rather than to deploy it. It knows nothing about what the worker already
 * has bound, so it must never be the path a real deploy takes.
 */
export function unreservedPort(): number {
  return PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
}
