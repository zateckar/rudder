<!--
  Renders whatever `showToast` has queued. Drop one of these anywhere on a page;
  it positions itself.
-->
<script lang="ts">
  import { toasts } from '$lib/client/toast.svelte';
</script>

<div class="toasts">
  {#each toasts as toast (toast.id)}
    <div class="toast {toast.type}" role="status">{toast.message}</div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed; top: 20px; right: 20px; z-index: 2000;
    display: flex; flex-direction: column; gap: 8px;
  }
  .toast {
    padding: 12px 20px; border-radius: var(--radius-md); font-size: 14px; font-weight: 500;
    box-shadow: var(--shadow-md); animation: slide-in 0.2s ease;
    max-width: 420px;
  }
  .toast.success { background: var(--green-subtle); color: var(--green-text); border: 1px solid var(--green); }
  .toast.error   { background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red); }
  @keyframes slide-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
</style>
