/**
 * The gate a blue/green deploy has to pass before traffic moves.
 *
 * `verifyGeneration` is the function that decides whether a newly created
 * generation is allowed to take over from the one currently serving. Getting it
 * wrong in either direction is expensive: too eager and a broken version takes
 * production, too reluctant and every deploy times out and rolls itself back.
 *
 * It had no tests, because it took a `PodmanClient` and this repository does not
 * mock. It now takes the one method it calls, plus an injected clock — the same
 * shape `applyToContainers` uses in deploy/lifecycle.ts — so the whole state
 * machine can be driven from here without a worker or a real wait.
 */
import { describe, expect, test } from 'bun:test';
import {
  verifyGeneration,
  type CreatedContainer,
  type VerificationClock,
  type VerificationSource,
} from './deploy';
import { SETTLE_MS } from './generations';
import type { ContainerInspect } from './podman';

type Health = 'starting' | 'healthy' | 'unhealthy';

/** A container's inspect response, reduced to what verification reads. */
function inspect(opts: {
  running?: boolean;
  exitCode?: number;
  health?: Health | null;
  restarts?: number;
} = {}): ContainerInspect {
  return {
    Id: 'x',
    Name: '/x',
    Config: { Image: 'nginx', Labels: {} },
    State: {
      Status: opts.running === false ? 'exited' : 'running',
      Running: opts.running !== false,
      Pid: 1,
      ExitCode: opts.exitCode ?? 0,
      ...(opts.health ? { Health: { Status: opts.health } } : {}),
    },
    RestartCount: opts.restarts ?? 0,
    HostConfig: {},
    NetworkSettings: { IPAddress: '10.0.0.2' },
  } as ContainerInspect;
}

const one: CreatedContainer[] = [{ rowId: 'r1', containerId: 'c1', name: 'web-g2' }];

/**
 * A clock that advances only when the code under test waits, so a 120-second
 * health timeout costs no real time and the test is deterministic.
 */
function fakeClock(): VerificationClock & { elapsed: () => number } {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms: number) => { t += ms; },
    elapsed: () => t,
  };
}

/** Answers a scripted sequence, repeating the last entry forever. */
function scripted(states: ContainerInspect[]): VerificationSource & { calls: () => number } {
  let i = 0;
  return {
    getContainer: async () => states[Math.min(i++, states.length - 1)],
    calls: () => i,
  };
}

describe('verifyGeneration', () => {
  test('nothing to verify returns immediately', async () => {
    const source = scripted([inspect()]);
    await verifyGeneration(source, [], 1000, fakeClock());
    expect(source.calls()).toBe(0);
  });

  test('a healthy container is accepted at once', async () => {
    const clock = fakeClock();
    await verifyGeneration(scripted([inspect({ health: 'healthy' })]), one, 120_000, clock);
    // Accepted on the health check, so it does not sit through the settle window.
    expect(clock.elapsed()).toBe(0);
  });

  test('a container with no health check is accepted only after it settles', async () => {
    const clock = fakeClock();
    await verifyGeneration(scripted([inspect({ health: null })]), one, 120_000, clock);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(SETTLE_MS);
  });

  test('unhealthy fails the deploy rather than waiting for the timeout', async () => {
    const attempt = verifyGeneration(
      scripted([inspect({ health: 'unhealthy' })]),
      one,
      120_000,
      fakeClock(),
    );
    expect(attempt).rejects.toThrow(/failed its health check/);
  });

  test('a container that exited names its exit code', async () => {
    const attempt = verifyGeneration(
      scripted([inspect({ running: false, exitCode: 137 })]),
      one,
      120_000,
      fakeClock(),
    );
    expect(attempt).rejects.toThrow(/exited with code 137/);
  });

  test('a crash loop is caught even though the container is running again', async () => {
    // The case `RestartCount` exists for: with `restart: always`, a container
    // that dies is back up by the next poll, so "is it running" alone cannot
    // tell a healthy start from a crash loop.
    const attempt = verifyGeneration(
      scripted([
        inspect({ health: 'starting', restarts: 0 }),
        inspect({ health: 'starting', restarts: 1 }),
      ]),
      one,
      120_000,
      fakeClock(),
    );
    expect(attempt).rejects.toThrow(/is restarting \(1 restarts\)/);
  });

  test('a restart count that was already non-zero is a baseline, not a failure', async () => {
    // A retained generation being restarted for a fast rollback has a history.
    // Only an *increase* during the wait means it is crash-looping.
    const clock = fakeClock();
    await verifyGeneration(
      scripted([inspect({ health: 'healthy', restarts: 7 })]),
      one,
      120_000,
      clock,
    );
    expect(clock.elapsed()).toBe(0);
  });

  test('a container that never reports healthy times out, naming it', async () => {
    const attempt = verifyGeneration(
      scripted([inspect({ health: 'starting' })]),
      one,
      5_000,
      fakeClock(),
    );
    expect(attempt).rejects.toThrow(/Timed out after 5s waiting for web-g2/);
  });

  test('the timeout says the previous version is still serving', async () => {
    // The sentence matters: it is what tells an operator reading a failed
    // deploy that they do not have an outage.
    const attempt = verifyGeneration(
      scripted([inspect({ health: 'starting' })]),
      one,
      1_000,
      fakeClock(),
    );
    expect(attempt).rejects.toThrow(/previous version is still serving/);
  });

  test('a container that disappears mid-wait is reported as vanished', async () => {
    const source: VerificationSource = {
      getContainer: async () => { throw new Error('no such container'); },
    };
    const attempt = verifyGeneration(source, one, 120_000, fakeClock());
    expect(attempt).rejects.toThrow(/vanished while starting: no such container/);
  });

  test('every container must pass, not just the first', async () => {
    const many: CreatedContainer[] = [
      { rowId: 'r1', containerId: 'ok', name: 'web-g2' },
      { rowId: 'r2', containerId: 'bad', name: 'db-g2' },
    ];
    const source: VerificationSource = {
      getContainer: async (id) =>
        id === 'ok' ? inspect({ health: 'healthy' }) : inspect({ health: 'unhealthy' }),
    };
    const attempt = verifyGeneration(source, many, 120_000, fakeClock());
    expect(attempt).rejects.toThrow(/'db-g2' started but failed its health check/);
  });

  test('a slow starter is accepted once it turns healthy', async () => {
    const clock = fakeClock();
    await verifyGeneration(
      scripted([
        inspect({ health: 'starting' }),
        inspect({ health: 'starting' }),
        inspect({ health: 'healthy' }),
      ]),
      one,
      120_000,
      clock,
    );
    // It polled rather than giving up, and did not need the full timeout.
    expect(clock.elapsed()).toBeGreaterThan(0);
    expect(clock.elapsed()).toBeLessThan(120_000);
  });

  test('a mixed generation waits for the slowest member', async () => {
    const many: CreatedContainer[] = [
      { rowId: 'r1', containerId: 'fast', name: 'web-g2' },
      { rowId: 'r2', containerId: 'slow', name: 'db-g2' },
    ];
    let slowPolls = 0;
    const source: VerificationSource = {
      getContainer: async (id) => {
        if (id === 'fast') return inspect({ health: 'healthy' });
        slowPolls += 1;
        return inspect({ health: slowPolls >= 3 ? 'healthy' : 'starting' });
      },
    };
    await verifyGeneration(source, many, 120_000, fakeClock());
    expect(slowPolls).toBe(3);
  });
});
