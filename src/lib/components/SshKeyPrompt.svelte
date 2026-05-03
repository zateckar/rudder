<script lang="ts">
  import { onMount } from 'svelte';

  let {
    workerId,
    title = 'SSH Key Required',
    description = 'Paste the SSH private key for this operation. The key is used once and never stored on the server.',
    submitLabel = 'Continue',
    onsubmit,
    oncancel,
  }: {
    workerId: string;
    title?: string;
    description?: string;
    submitLabel?: string;
    onsubmit: (key: string) => void;
    oncancel: () => void;
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

<div class="modal-overlay" onclick={oncancel} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <h3>{title}</h3>
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

    <div class="modal-actions">
      <button class="btn-secondary" onclick={oncancel}>Cancel</button>
      <button class="btn-primary" disabled={!sshKey.trim() || loading} onclick={handleSubmit}>
        {loading ? 'Working…' : submitLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--bg-surface); border: 1px solid var(--border-default);
    border-radius: var(--radius-lg); padding: 28px; max-width: 520px; width: 90%;
    box-shadow: var(--shadow-lg);
  }
  .modal h3 { margin: 0 0 8px; font-size: 16px; color: var(--text-primary); }
  .modal-desc { font-size: 13px; color: var(--text-secondary); margin: 0 0 16px; line-height: 1.5; }
  .form-group { margin-bottom: 12px; }
  .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
  .form-group textarea {
    width: 100%; font-family: var(--font-mono); font-size: 12px;
    background: var(--bg-root); border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); padding: 10px; color: var(--text-primary);
    resize: vertical; box-sizing: border-box;
  }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .btn-secondary {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    background: var(--bg-raised); border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer;
  }
  .btn-primary {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600;
    background: var(--accent); border: none; color: var(--bg-root); cursor: pointer;
  }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .error-msg {
    background: var(--red-subtle); color: var(--red-text); padding: 8px 12px;
    border-radius: var(--radius-sm); font-size: 12px; margin-bottom: 12px;
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
