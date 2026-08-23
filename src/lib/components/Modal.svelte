<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Two-way: set false to close, and the component sets it false itself. */
    open: boolean;
    title: string;
    /** Widened for content that needs the room, e.g. a pasted SSH key. */
    maxWidth?: string;
    /** Called after `open` goes false, for callers with teardown of their own. */
    onclose?: () => void;
    children: Snippet;
  }

  let { open = $bindable(), title, maxWidth = '440px', onclose, children }: Props = $props();

  const titleId = `modal-title-${crypto.randomUUID().slice(0, 8)}`;
  let dialog = $state<HTMLDivElement | null>(null);
  let restoreFocusTo: HTMLElement | null = null;

  function close() {
    if (!open) return;
    open = false;
    onclose?.();
  }

  /**
   * Escape is handled on the window, not on the backdrop.
   *
   * Every hand-rolled copy of this put `onkeydown` on a `tabindex="-1"` element
   * that nothing ever focused, so Escape did nothing at all — the only way out
   * was the Cancel button or a click on the backdrop.
   */
  function onWindowKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') trapFocus(event);
  }

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Keep Tab inside the dialog; a modal the user can tab out of is not modal. */
  function trapFocus(event: KeyboardEvent) {
    if (!dialog) return;
    const targets = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
    if (targets.length === 0) return;
    const first = targets[0];
    const last = targets[targets.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (!open) return;

    restoreFocusTo = document.activeElement as HTMLElement | null;
    // The page behind must not scroll while a dialog is over it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first control, or the dialog itself if it has none.
    const target =
      dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog ?? null;
    target?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusTo?.focus?.();
    };
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
  <!-- The backdrop is decoration: it is not focusable and carries no role, so
       assistive tech sees only the dialog.
       svelte-ignore a11y_click_events_have_key_events — clicking the backdrop
       is a pointer shortcut for dismissing; the keyboard equivalent is Escape,
       handled on the window above so it works wherever focus happens to be. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" onclick={close} role="presentation">
    <div
      class="modal"
      style="max-width: {maxWidth}"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabindex="-1"
    >
      <h3 id={titleId}>{title}</h3>
      {@render children()}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
  }

  .modal {
    width: 100%;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    padding: 28px;
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }

  .modal:focus {
    outline: none;
  }

  .modal h3 {
    margin: 0 0 12px;
    color: var(--text-primary);
    font-size: 17px;
    font-weight: 700;
  }
</style>
