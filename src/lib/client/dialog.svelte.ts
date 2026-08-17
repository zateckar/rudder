/**
 * Confirmation and disclosure dialogs, in the page rather than the browser.
 *
 * `confirm()` blocks the whole page, cannot be styled or read by the app, and
 * is suppressed outright by some automation and kiosk browsers — where it
 * returns false, so every guarded control silently becomes a no-op. That is a
 * bad failure mode for a control plane: "Delete worker" appearing to do nothing
 * is indistinguishable from it being broken.
 *
 * `await confirmAction({...})` resolves true or false, so call sites read
 * almost exactly as they did.
 */

export interface ConfirmRequest {
  title: string;
  /** The consequence, in a sentence. Shown under the title. */
  body?: string;
  /** Label for the affirmative button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Style the affirmative button as destructive. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

/** The dialog currently on screen, if any. Rendered by `<ConfirmDialog />`. */
export const dialogState = $state<{ pending: PendingConfirm | null }>({ pending: null });

/**
 * Ask the operator to confirm. Resolves false if they decline or dismiss.
 *
 * One at a time: a second request while one is open resolves the first as
 * declined rather than losing its promise.
 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  if (dialogState.pending) {
    dialogState.pending.resolve(false);
    dialogState.pending = null;
  }
  return new Promise<boolean>((resolve) => {
    dialogState.pending = { ...request, resolve };
  });
}

/** Answer the open dialog. */
export function settleDialog(ok: boolean): void {
  const pending = dialogState.pending;
  if (!pending) return;
  dialogState.pending = null;
  pending.resolve(ok);
}
