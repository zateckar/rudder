import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from './concurrency';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('mapWithConcurrency', () => {
  test('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 1, 20, 2], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 1, 20, 2]);
  });

  test('never runs more than `limit` at once', async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await tick();
      live -= 1;
    });
    expect(peak).toBe(3);
  });

  test('a limit above the item count does not spawn idle workers', async () => {
    let peak = 0;
    let live = 0;
    await mapWithConcurrency([1, 2], 50, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await tick();
      live -= 1;
    });
    expect(peak).toBe(2);
  });

  test('an empty list does no work', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => { calls += 1; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  test('a slow item does not hold back the ones behind it', async () => {
    // Two lanes, one very slow item first. With fixed chunking the three fast
    // items behind it would wait; pulling from a shared cursor they do not.
    const order: number[] = [];
    await mapWithConcurrency([50, 1, 1, 1], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(i);
    });
    expect(order[order.length - 1]).toBe(0);
  });

  test('a rejection propagates rather than being swallowed', async () => {
    const attempt = mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(attempt).rejects.toThrow('boom');
  });
});
