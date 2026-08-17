<!--
  Renders whatever `confirmAction` is waiting on. Place one per page, next to
  `<Toasts />`.
-->
<script lang="ts">
  import { dialogState, settleDialog } from '$lib/client/dialog.svelte';

  const pending = $derived(dialogState.pending);

  let confirmButton = $state<HTMLButtonElement | undefined>();
  let cancelButton = $state<HTMLButtonElement | undefined>();

  /**
   * Move focus into the dialog when it opens — otherwise a keyboard user is
   * still on the page behind it, and Escape has nothing to close.
   *
   * A destructive action gets Cancel focused rather than Confirm: the whole
   * point of the dialog is that deleting a worker should not be one stray
   * Enter away.
   */
  $effect(() => {
    if (!pending) return;
    const target = pending.danger ? cancelButton : confirmButton;
    target?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    if (!pending) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      settleDialog(false);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => settleDialog(false)}></div>
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title">{pending.title}</h2>
    {#if pending.body}
      <p>{pending.body}</p>
    {/if}
    <div class="actions">
      <button class="btn-cancel" bind:this={cancelButton} onclick={() => settleDialog(false)}>
        Cancel
      </button>
      <button
        class="btn-confirm"
        class:danger={pending.danger}
        bind:this={confirmButton}
        onclick={() => settleDialog(true)}
      >
        {pending.confirmLabel ?? 'Confirm'}
      </button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 2500;
    background: rgba(0, 0, 0, 0.5);
  }
  .dialog {
    position: fixed; z-index: 2501;
    top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(440px, calc(100vw - 32px));
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    padding: 20px 22px;
  }
  .dialog h2 {
    margin: 0 0 8px;
    font-size: 16px;
    color: var(--text-primary);
  }
  .dialog p {
    margin: 0 0 18px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .actions button {
    padding: 7px 14px;
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-subtle);
  }
  .btn-cancel {
    background: var(--bg-overlay);
    color: var(--text-secondary);
  }
  .btn-cancel:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-confirm {
    background: var(--accent-subtle);
    color: var(--accent-text, var(--accent));
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .btn-confirm:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .btn-confirm.danger {
    background: var(--red-subtle);
    color: var(--red-text);
    border-color: color-mix(in srgb, var(--red) 35%, transparent);
  }
  .btn-confirm.danger:hover { background: color-mix(in srgb, var(--red) 18%, transparent); }
</style>
