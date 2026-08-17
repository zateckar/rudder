/**
 * The one place a page tells the operator that something worked or did not.
 *
 * Pages that had no toast of their own fell back to `alert()`, which blocks the
 * page, cannot be styled, is suppressed outright by some automation browsers,
 * and — because it takes a string — encourages handing the user whatever the
 * server said, raw JSON included.
 */

export interface Toast {
  id: number;
  type: 'success' | 'error';
  message: string;
}

/** Visible toasts, oldest first. Render with `<Toasts />`. */
export const toasts = $state<Toast[]>([]);

let counter = 0;

/** How long a toast stays up. Long enough to read a sentence. */
const LIFETIME_MS = 4000;

export function showToast(type: Toast['type'], message: string): void {
  const id = ++counter;
  toasts.push({ id, type, message });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
  }, LIFETIME_MS);
}
