import { describe, expect, it } from 'bun:test';
import { formatBytes, formatDate, formatDateTime, formatTime, formatUptime, timeAgo } from './format';

describe('formatBytes', () => {
  it('prints whole bytes without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps up a unit at each 1024 boundary', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('saturates at the largest unit instead of reading past the scale', () => {
    // Three of the copies this replaced produced "1.0 undefined" here.
    expect(formatBytes(1024 ** 5)).toBe('1.0 PB');
    expect(formatBytes(1024 ** 7)).toBe('1048576.0 PB');
  });

  it('distinguishes an absent measurement from a zero one', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(null, { empty: 'n/a' })).toBe('n/a');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('honours an explicit precision', () => {
    expect(formatBytes(1536, { decimals: 2 })).toBe('1.50 KB');
    expect(formatBytes(1536, { decimals: 0 })).toBe('2 KB');
  });

  it('keeps the sign on a negative delta', () => {
    expect(formatBytes(-2048)).toBe('-2.0 KB');
  });
});

describe('formatDateTime / formatDate', () => {
  const when = new Date('2026-03-04T05:06:07Z');

  it('accepts a Date, an ISO string and an epoch', () => {
    expect(formatDateTime(when)).toBe(when.toLocaleString());
    expect(formatDateTime(when.toISOString())).toBe(when.toLocaleString());
    expect(formatDateTime(when.getTime())).toBe(when.toLocaleString());
    expect(formatDate(when)).toBe(when.toLocaleDateString());
  });

  it('names the empty case rather than printing "Invalid Date"', () => {
    expect(formatDateTime(null)).toBe('Never');
    expect(formatDateTime('')).toBe('Never');
    expect(formatDate(undefined)).toBe('Never');
    expect(formatDateTime(null, '—')).toBe('—');
  });

  it('returns unparseable input unchanged', () => {
    expect(formatDateTime('whenever')).toBe('whenever');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-03-04T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('reads long by default', () => {
    expect(timeAgo(ago(30_000), 'long', now)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), 'long', now)).toBe('5 min ago');
    expect(timeAgo(ago(60 * 60_000), 'long', now)).toBe('1 hour ago');
    expect(timeAgo(ago(3 * 60 * 60_000), 'long', now)).toBe('3 hours ago');
    expect(timeAgo(ago(24 * 60 * 60_000), 'long', now)).toBe('1 day ago');
    expect(timeAgo(ago(5 * 24 * 60 * 60_000), 'long', now)).toBe('5 days ago');
  });

  it('reads short when asked', () => {
    expect(timeAgo(ago(5 * 60_000), 'short', now)).toBe('5m ago');
    expect(timeAgo(ago(3 * 60 * 60_000), 'short', now)).toBe('3h ago');
    expect(timeAgo(ago(5 * 24 * 60 * 60_000), 'short', now)).toBe('5d ago');
  });

  it('does not count forwards for a clock that is slightly ahead', () => {
    expect(timeAgo(new Date(now + 5_000).toISOString(), 'long', now)).toBe('just now');
  });

  it('handles nothing to report', () => {
    expect(timeAgo(null)).toBe('—');
    expect(timeAgo('whenever')).toBe('—');
  });
});

describe('formatUptime', () => {
  it('passes through the sentence Podman already produced', () => {
    expect(formatUptime('up 45 days, 2 hours')).toBe('up 45 days, 2 hours');
  });

  it('formats a count of seconds by its largest two units', () => {
    expect(formatUptime(45 * 86400 + 2 * 3600)).toBe('45d 2h');
    expect(formatUptime(5 * 3600 + 30 * 60)).toBe('5h 30m');
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(45)).toBe('45s');
  });

  it('reports nothing for absent or nonsensical input', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(-1)).toBe('—');
  });
});

describe('formatTime', () => {
  const when = new Date('2026-03-04T05:06:07Z');

  it('prints hours and minutes, and seconds only when asked', () => {
    expect(formatTime(when)).toBe(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    expect(formatTime(when, { seconds: true }))
      .toBe(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  });

  it('prints a dash for nothing to show', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatTime('whenever')).toBe('—');
  });
});
