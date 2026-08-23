/**
 * What the operator is told after starting, stopping or restarting an
 * application.
 *
 * The loop these functions replace reported `{ success: true, message:
 * 'Application stopped' }` whether it had stopped five containers or none — the
 * per-container error went to `console.error` and no further. No button called
 * it, so nothing surfaced the lie; the header controls do, which is why the
 * accounting is what gets covered here.
 */
import { describe, expect, test } from 'bun:test';
import { applyToContainers, lifecycleMessage } from './lifecycle';

/** Three containers, named the way a compose application's are. */
const ROWS = [
  { id: 'row-web', name: 'shop-abcdef12-web', containerId: 'cid-web' },
  { id: 'row-api', name: 'shop-abcdef12-api', containerId: 'cid-api' },
  { id: 'row-db', name: 'shop-abcdef12-db', containerId: 'cid-db' },
];

/** Fails for the named container ids, succeeds for the rest, records the order. */
function op(failFor: string[] = []) {
  const called: string[] = [];
  const run = async (containerId: string) => {
    called.push(containerId);
    if (failFor.includes(containerId)) {
      throw new Error(`no such container ${containerId}`);
    }
  };
  return { run, called };
}

describe('applyToContainers', () => {
  test('reports every container when they all take it', async () => {
    const { run, called } = op();
    const outcome = await applyToContainers(ROWS, run);

    expect(outcome.succeeded).toEqual(['row-web', 'row-api', 'row-db']);
    expect(outcome.failures).toEqual([]);
    // In order. Compose honours depends_on when the plan is built, and starting
    // a dependency and its dependent at the same instant defeats that.
    expect(called).toEqual(['cid-web', 'cid-api', 'cid-db']);
  });

  test('one failure does not stop the containers behind it', async () => {
    // The bug this guards: a container that is already gone must not block the
    // two after it, and must not be reported as having taken the action.
    const { run, called } = op(['cid-api']);
    const outcome = await applyToContainers(ROWS, run);

    expect(outcome.succeeded).toEqual(['row-web', 'row-db']);
    expect(outcome.failures).toEqual([
      { name: 'shop-abcdef12-api', message: 'no such container cid-api' },
    ]);
    expect(called).toHaveLength(3);
  });

  test('records every failure when none of them take it', async () => {
    const { run } = op(['cid-web', 'cid-api', 'cid-db']);
    const outcome = await applyToContainers(ROWS, run);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failures).toHaveLength(3);
  });

  test('an error with no message still names the container', async () => {
    const outcome = await applyToContainers([ROWS[0]], async () => {
      throw new Error('');
    });

    expect(outcome.failures).toEqual([
      { name: 'shop-abcdef12-web', message: 'unknown error' },
    ]);
  });

  test('does nothing, and does not throw, on an empty list', async () => {
    const { run, called } = op();
    const outcome = await applyToContainers([], run);

    expect(outcome).toEqual({ succeeded: [], failures: [] });
    expect(called).toEqual([]);
  });
});

describe('lifecycleMessage', () => {
  const clean = (ids: string[]) => ({ succeeded: ids, failures: [] });

  test('says the count for a multi-container application', () => {
    // The whole reason an application-level control exists: "Application
    // stopped" is the same sentence for one container and for five.
    expect(lifecycleMessage('stopped', 3, clean(['a', 'b', 'c']))).toBe(
      'Application stopped (3 containers).',
    );
  });

  test('leaves the count off when there is only one container', () => {
    expect(lifecycleMessage('started', 1, clean(['a']))).toBe('Application started.');
  });

  test('reports a partial failure as a partial failure', () => {
    const message = lifecycleMessage('stopped', 3, {
      succeeded: ['a', 'b'],
      failures: [{ name: 'db', message: 'connection refused' }],
    });

    expect(message).toBe('Stopped 2 of 3 containers. db: connection refused');
  });

  test('does not claim anything happened when nothing did', () => {
    const message = lifecycleMessage('restarted', 3, {
      succeeded: [],
      failures: [
        { name: 'web', message: 'timeout' },
        { name: 'api', message: 'timeout' },
        { name: 'db', message: 'timeout' },
      ],
    });

    expect(message).toStartWith('Could not restart any of the 3 containers.');
    expect(message).toContain('web: timeout');
  });

  test('a single container that refused reads as one container', () => {
    const message = lifecycleMessage('stopped', 1, {
      succeeded: [],
      failures: [{ name: 'web', message: 'timeout' }],
    });

    expect(message).toBe('Could not stop the container. web: timeout');
  });

  test('summarises once there are more failures than a toast can hold', () => {
    const failures = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, message: 'timeout' }));
    const message = lifecycleMessage('stopped', 5, { succeeded: [], failures });

    expect(message).toContain('a: timeout; b: timeout; c: timeout; and 2 more');
    expect(message).not.toContain('d: timeout');
  });

  test('says there was nothing to act on rather than claiming success', () => {
    expect(lifecycleMessage('stopped', 0, clean([]))).toBe(
      'No active containers — nothing to stop.',
    );
  });
});
