import { describe, expect, test } from 'bun:test';
import { PORT_RANGE_END, PORT_RANGE_START, pickFreePort, unreservedPort } from './ports';

describe('port range', () => {
  test('stays below the kernel ephemeral floor', () => {
    // Linux's default net.ipv4.ip_local_port_range starts at 32768. A host port
    // above it can be held transiently by an outbound connection, and the
    // container then fails to start with `bind: address already in use` naming
    // a port no container holds.
    expect(PORT_RANGE_END).toBeLessThanOrEqual(32768);
    expect(PORT_RANGE_START).toBeLessThan(PORT_RANGE_END);
  });
});

describe('pickFreePort', () => {
  test('returns a port inside the range', () => {
    const port = pickFreePort(new Set());
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThan(PORT_RANGE_END);
  });

  test('never returns a reserved port', () => {
    const taken = new Set<number>();
    for (let p = PORT_RANGE_START; p < PORT_RANGE_END - 1; p++) taken.add(p);
    // One port left; the random draws will all collide and the linear scan has
    // to find it.
    expect(pickFreePort(taken)).toBe(PORT_RANGE_END - 1);
  });

  test('throws rather than handing out a port that is already bound', () => {
    const taken = new Set<number>();
    for (let p = PORT_RANGE_START; p < PORT_RANGE_END; p++) taken.add(p);
    expect(() => pickFreePort(taken)).toThrow(/No free host port/);
  });
});

describe('unreservedPort', () => {
  test('draws from the same range', () => {
    for (let i = 0; i < 100; i++) {
      const port = unreservedPort();
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(port).toBeLessThan(PORT_RANGE_END);
    }
  });
});
