/**
 * Display formatting shared by pages and API responses.
 *
 * These existed as eleven copies across nine files, no two alike: `formatBytes`
 * had four definitions that disagreed on what to print for zero ('0 B' vs '—'),
 * how many decimals to use, and how far the unit scale went — and three of them
 * indexed past the end of that scale for anything above the largest unit, so a
 * petabyte rendered as "1.0 undefined".
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export interface FormatBytesOptions {
  /** Printed for null, undefined and NaN. Defaults to '—'. */
  empty?: string;
  /** Decimal places. Defaults to 1, and to 0 for whole bytes. */
  decimals?: number;
}

/**
 * A byte count as the largest unit that keeps it above 1.
 *
 * Zero is `'0 B'` — a real measurement, unlike null, which is `empty`. The unit
 * index is clamped, so a value beyond the scale saturates at PB instead of
 * reading past the array.
 */
export function formatBytes(
  bytes: number | null | undefined,
  options: FormatBytesOptions = {},
): string {
  const { empty = '—', decimals } = options;
  if (bytes == null || Number.isNaN(bytes)) return empty;
  if (bytes === 0) return '0 B';

  const negative = bytes < 0;
  const value = Math.abs(bytes);
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** index;
  const places = decimals ?? (index === 0 ? 0 : 1);
  return `${negative ? '-' : ''}${scaled.toFixed(places)} ${BYTE_UNITS[index]}`;
}

/** A date and time in the viewer's locale. Unparseable input is returned as-is. */
export function formatDateTime(value: Date | string | number | null | undefined, empty = 'Never'): string {
  if (value == null || value === '') return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** A date without the time, in the viewer's locale. */
export function formatDate(value: Date | string | number | null | undefined, empty = 'Never'): string {
  if (value == null || value === '') return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

/**
 * How long ago something happened.
 *
 * `'long'` reads "5 min ago"; `'short'` reads "5m ago". Both spellings were in
 * use, so both are still available rather than silently restyling one of the
 * two pages.
 */
export function timeAgo(
  value: Date | string | number | null | undefined,
  style: 'long' | 'short' = 'long',
  now: number = Date.now(),
): string {
  if (value == null || value === '') return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'just now';
  if (style === 'short') {
    if (hours < 1) return `${minutes}m ago`;
    if (days < 1) return `${hours}h ago`;
    return `${days}d ago`;
  }
  if (hours < 1) return `${minutes} min ago`;
  if (days < 1) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * An uptime, either as seconds or as the sentence Podman already produced.
 *
 * Podman reports uptime as prose ("up 45 days, 2 hours"); the metrics tables
 * report it as a number. Both reach the same column.
 */
export function formatUptime(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (Number.isNaN(value) || value < 0) return '—';

  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(value)}s`;
}

/** A clock time for chart axes — `hh:mm`, or `hh:mm:ss` when seconds matter. */
export function formatTime(
  value: Date | string | number | null | undefined,
  options: { seconds?: boolean } = {},
): string {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  });
}
