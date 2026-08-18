/**
 * The limiter itself, and the question of whether its address key means anything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { addressIsDistinguishing, consume, reset } from './rate-limit';

const OPTS = { limit: 3, windowMs: 60_000, blockMs: 60_000 };

describe('consume', () => {
  test('allows up to the limit, then blocks', () => {
    const key = `test:${crypto.randomUUID()}`;
    expect(consume(key, OPTS).allowed).toBe(true);
    expect(consume(key, OPTS).allowed).toBe(true);
    expect(consume(key, OPTS).allowed).toBe(true);

    const blocked = consume(key, OPTS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('stays blocked once tripped, so the block outlives the count', () => {
    const key = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 4; i++) consume(key, OPTS);
    expect(consume(key, OPTS).allowed).toBe(false);
  });

  test('reset clears the counter', () => {
    const key = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 4; i++) consume(key, OPTS);
    reset(key);
    expect(consume(key, OPTS).allowed).toBe(true);
  });

  test('keys are independent', () => {
    const a = `test:${crypto.randomUUID()}`;
    const b = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 4; i++) consume(a, OPTS);
    expect(consume(b, OPTS).allowed).toBe(true);
  });
});

describe('addressIsDistinguishing', () => {
  const VARS = ['ADDRESS_HEADER', 'PROTOCOL_HEADER', 'HOST_HEADER'] as const;
  const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

  const clear = () => VARS.forEach((v) => delete process.env[v]);

  afterEach(() => {
    for (const v of VARS) {
      if (original[v] === undefined) delete process.env[v];
      else process.env[v] = original[v];
    }
  });

  test('an unproxied deployment distinguishes callers', () => {
    clear();
    expect(addressIsDistinguishing()).toBe(true);
  });

  test('a proxied deployment with no ADDRESS_HEADER does not', () => {
    // The case that turned a per-address limit into an installation-wide one:
    // every caller shares the proxy's address, so tripping the bucket locks
    // everyone out at once.
    clear();
    process.env.PROTOCOL_HEADER = 'X-Forwarded-Proto';
    expect(addressIsDistinguishing()).toBe(false);
  });

  test('HOST_HEADER alone is enough to mean "proxied"', () => {
    clear();
    process.env.HOST_HEADER = 'X-Forwarded-Host';
    expect(addressIsDistinguishing()).toBe(false);
  });

  test('a configured ADDRESS_HEADER makes the address meaningful again', () => {
    clear();
    process.env.PROTOCOL_HEADER = 'X-Forwarded-Proto';
    process.env.ADDRESS_HEADER = 'X-Forwarded-For';
    expect(addressIsDistinguishing()).toBe(true);
  });

  test('a forwarded header on its own says nothing', () => {
    // The whole point of reading this from the environment: an attacker on a
    // direct connection must not be able to switch their own per-address limit
    // off by sending X-Forwarded-For. Nothing here takes a request, and the
    // login action asserts the same end to end — see auth-boundary.test.ts.
    clear();
    expect(addressIsDistinguishing.length).toBe(0);
    expect(addressIsDistinguishing()).toBe(true);
  });
});
