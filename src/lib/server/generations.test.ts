import { describe, expect, test } from 'bun:test';
import {
  CONFIG_POLL_INTERVAL_MS,
  CUTOVER_CONVERGENCE_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_S,
  DRAIN_GRACE_MS,
  declaresFixedHostPorts,
  generationalName,
  healthTimeoutMs,
  nextGeneration,
  parseGenerationalName,
  retentionExpired,
  retentionMs,
  supportsBlueGreen,
} from './generations';

describe('generational names', () => {
  test('suffixes the generation', () => {
    expect(generationalName('whoami-1a2b3c4d', 2)).toBe('whoami-1a2b3c4d-g2');
  });

  test('round-trips', () => {
    const name = generationalName('api-deadbeef-3', 12);
    expect(parseGenerationalName(name)).toEqual({ base: 'api-deadbeef-3', generation: 12 });
  });

  test('recovers the base when it already ends in something g-like', () => {
    // A compose service called `config` produces `app-1234abcd-config-g2`, and
    // the naive split on `-g` would hand back `app-1234abcd-confi`.
    expect(parseGenerationalName('app-1234abcd-config-g2')).toEqual({
      base: 'app-1234abcd-config',
      generation: 2,
    });
  });

  test('is null for a name without a generation', () => {
    // Containers deployed before generations existed, and containers on the
    // worker that Rudder did not create. Both must be recognisable as such.
    expect(parseGenerationalName('whoami-1a2b3c4d')).toBeNull();
    expect(parseGenerationalName('traefik')).toBeNull();
    expect(parseGenerationalName('-g2')).toBeNull();
  });
});

describe('nextGeneration', () => {
  test('starts at 1 when nothing is deployed', () => {
    expect(nextGeneration([])).toBe(1);
  });

  test('is one past the highest live generation', () => {
    expect(nextGeneration([1, 2])).toBe(3);
  });

  test('skips past a gap rather than filling it', () => {
    // Filling a gap would reuse a name that a container left behind by a failed
    // deploy may still be holding — the one thing the number has to prevent.
    expect(nextGeneration([1, 5])).toBe(6);
  });

  test('ignores values that are not numbers', () => {
    expect(nextGeneration([1, NaN, 3])).toBe(4);
  });
});

describe('supportsBlueGreen', () => {
  test('only http routing mode', () => {
    expect(supportsBlueGreen({ routingMode: 'http' })).toBe(true);
    expect(supportsBlueGreen({ routingMode: 'labels' })).toBe(false);
    expect(supportsBlueGreen({})).toBe(false);
    expect(supportsBlueGreen({ routingMode: null })).toBe(false);
  });
});

describe('declaresFixedHostPorts', () => {
  const single = (ports: unknown, replicas = 1) => ({
    type: 'single',
    replicas,
    manifest: JSON.stringify({ image: 'nginx:1.27', ports }),
  });

  test('true when a single container asks for a specific host port', () => {
    expect(declaresFixedHostPorts(single([{ containerPort: '80', hostPort: '8080' }]))).toBe(true);
  });

  test('false when the host port is left to Rudder', () => {
    expect(declaresFixedHostPorts(single([{ containerPort: '80', hostPort: '' }]))).toBe(false);
    expect(declaresFixedHostPorts(single([{ containerPort: '80' }]))).toBe(false);
    expect(declaresFixedHostPorts(single([]))).toBe(false);
  });

  test('false for multiple replicas, which always get fresh ports', () => {
    expect(declaresFixedHostPorts(single([{ containerPort: '80', hostPort: '8080' }], 3))).toBe(false);
  });

  test('false for compose, whose host ports are always allocated', () => {
    expect(
      declaresFixedHostPorts({ type: 'compose', manifest: 'services:\n  web:\n    ports: ["8080:80"]' }),
    ).toBe(false);
  });

  test('false for a manifest that is just an image name', () => {
    expect(declaresFixedHostPorts({ type: 'single', manifest: 'nginx:1.27' })).toBe(false);
    expect(declaresFixedHostPorts({ type: 'single', manifest: null })).toBe(false);
  });
});

describe('healthTimeoutMs', () => {
  test('falls back to the default', () => {
    expect(healthTimeoutMs({})).toBe(DEFAULT_HEALTH_TIMEOUT_S * 1000);
    expect(healthTimeoutMs({ healthTimeoutSeconds: null })).toBe(DEFAULT_HEALTH_TIMEOUT_S * 1000);
  });

  test('treats zero as unset rather than as no wait at all', () => {
    expect(healthTimeoutMs({ healthTimeoutSeconds: 0 })).toBe(DEFAULT_HEALTH_TIMEOUT_S * 1000);
  });

  test('uses the configured value', () => {
    expect(healthTimeoutMs({ healthTimeoutSeconds: 30 })).toBe(30_000);
  });
});

describe('retentionMs', () => {
  test('defaults to no retention', () => {
    expect(retentionMs({})).toBe(0);
    expect(retentionMs({ retainPreviousMinutes: 0 })).toBe(0);
    expect(retentionMs({ retainPreviousMinutes: null })).toBe(0);
  });

  test('converts minutes', () => {
    expect(retentionMs({ retainPreviousMinutes: 10 })).toBe(600_000);
  });
});

describe('retentionExpired', () => {
  const at = (ms: number) => new Date(1_700_000_000_000 + ms);
  const drained = at(0);

  test('never reaps sooner than the drain grace, even with no retention', () => {
    // A generation only reaches the sweep when a deploy could not finish
    // reaping it. Removing it a second after traffic moved would cut off
    // whatever was still in flight.
    expect(retentionExpired({}, drained, at(DRAIN_GRACE_MS - 1))).toBe(false);
    expect(retentionExpired({}, drained, at(DRAIN_GRACE_MS))).toBe(true);
  });

  test('waits out a retention window longer than the grace', () => {
    const app = { retainPreviousMinutes: 10 };
    expect(retentionExpired(app, drained, at(DRAIN_GRACE_MS + 1))).toBe(false);
    expect(retentionExpired(app, drained, at(600_000 - 1))).toBe(false);
    expect(retentionExpired(app, drained, at(600_000))).toBe(true);
  });
});

describe('cutover timing', () => {
  test('allows more than one missed poll before giving up', () => {
    // A single missed tick is normal — systemd timers have slack, and the
    // fetch itself can take a moment. Failing on the first one would report
    // a cutover as unconfirmed on a perfectly healthy worker.
    expect(CUTOVER_CONVERGENCE_TIMEOUT_MS).toBeGreaterThan(CONFIG_POLL_INTERVAL_MS * 2);
  });
});
