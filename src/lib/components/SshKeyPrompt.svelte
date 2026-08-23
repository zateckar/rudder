<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from './Modal.svelte';

  let {
    workerId,
    title = 'SSH Key Required',
    description = 'Paste the SSH private key for this operation. The key is used once and never stored on the server.',
    submitLabel = 'Continue',
    onsubmit,
    oncancel,
    extra,
  }: {
    workerId: string;
    title?: string;
    description?: string;
    submitLabel?: string;
    onsubmit: (key: string) => void;
    oncancel: () => void;
    /** Extra controls for this particular operation, rendered above the buttons. */
    extra?: import('svelte').Snippet;
  } = $props();

  let sshKey = $state('');
  let rememberKey = $state(false);
  let hasVaultKey = $state(false);
  let loading = $state(false);
  let error = $state('');

  onMount(async () => {
    try {
      const { loadKeyFromVault, hasStoredKey } = await import('$lib/client/key-vault');
      if (hasStoredKey(workerId)) {
        hasVaultKey = true;
        const stored = await loadKeyFromVault(workerId);
        if (stored) {
          sshKey = stored;
        } else {
          hasVaultKey = false;
        }
      }
    } catch {
      // Key vault not available — ignore
    }
  });

  async function handleSubmit() {
    const key = sshKey.trim();
    if (!key) {
      error = 'SSH private key is required';
      return;
    }
    if (!key.includes('PRIVATE KEY')) {
      error = 'This does not look like a valid SSH private key';
      return;
    }
    error = '';
    loading = true;

    if (rememberKey) {
      try {
        const { saveKeyToVault } = await import('$lib/client/key-vault');
        await saveKeyToVault(workerId, key);
      } catch {
        // Non-fatal — key just won't be remembered
      }
    }

    onsubmit(key);
    loading = false;
  }

  async function handleForgetKey() {
    try {
      const { clearKey } = await import('$lib/client/key-vault');
      clearKey(workerId);
      hasVaultKey = false;
      sshKey = '';
    } catch {
      // ignore
    }
  }
</script>

<!-- Mounted only while it is wanted, so `open` is simply true; the caller
     unmounts us when `onclose` fires. -->
<Modal open {title} maxWidth="520px" onclose={oncancel}>
    <p class="modal-desc">{@html description}</p>

    {#if hasVaultKey}
      <div class="vault-notice">
        <span class="vault-icon">🔑</span>
        <span>Using remembered key for this worker.</span>
        <button class="btn-link" onclick={handleForgetKey}>Forget</button>
      </div>
    {/if}

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    <div class="form-group">
      <label for="sshKeyInput">SSH Private Key (PEM)</label>
      <textarea
        id="sshKeyInput"
        rows="8"
        placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
        bind:value={sshKey}
      ></textarea>
    </div>

    <label class="remember-toggle">
      <input type="checkbox" bind:checked={rememberKey} />
      <span>Remember this key (encrypted in browser)</span>
    </label>

    {@render extra?.()}

    <div class="modal-actions">
      <button class="btn-secondary" onclick={oncancel}>Cancel</button>
      <button class="btn-primary" disabled={!sshKey.trim() || loading} onclick={handleSubmit}>
        {loading ? 'Working…' : submitLabel}
      </button>
    </div>
</Modal>

<style>
  .modal-desc { font-size: 13px; color: var(--text-secondary); margin: 0 0 16px; line-height: 1.5; }
  .form-group textarea {
    width: 100%; font-family: var(--font-mono); font-size: 12px;
    background: var(--bg-root); border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); padding: 10px; color: var(--text-primary);
    resize: vertical; box-sizing: border-box;
  }
  .vault-notice {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--accent-subtle); border-radius: var(--radius-sm);
    font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;
  }
  .vault-icon { font-size: 14px; }
  .btn-link {
    background: none; border: none; color: var(--accent); cursor: pointer;
    font-size: 12px; text-decoration: underline; padding: 0;
  }
  .remember-toggle {
    display: flex; align-items: center; gap: 8px; font-size: 12px;
    color: var(--text-secondary); cursor: pointer; margin-bottom: 4px;
  }
  .remember-toggle input { accent-color: var(--accent); }
</style>
