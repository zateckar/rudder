/**
 * Run an async function over a list, a bounded number at a time.
 *
 * The background collector needs this in two places and for the same reason:
 * every worker is independent and every container's stats call is independent,
 * but doing them all at once would open one socket per container across the
 * whole fleet, and doing them one at a time makes a cycle take
 * `workers × containers × round-trip`. With the Podman client's 30 s request
 * timeout, one unresponsive worker used to stall the collection for every other
 * worker behind it.
 *
 * Order of results matches order of input. A rejection propagates — callers
 * that want per-item tolerance catch inside `fn`, which is what the collector
 * does, so one bad container cannot lose the rest of the batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  // Each worker pulls the next index until the list is exhausted, rather than
  // slicing into fixed chunks: a chunk containing one slow item would otherwise
  // hold its whole chunk's worth of slots idle.
  async function drain(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, drain));
  return results;
}
