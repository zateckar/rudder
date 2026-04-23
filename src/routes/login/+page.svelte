<script lang="ts">
  import { enhance } from '$app/forms';
  
  let { form, data } = $props();
  let loading = $state(false);
  let errorMessage = $state('');
  
  function handleSubmit() {
    errorMessage = '';
    loading = true;
  }

  const providerStyles: Record<string, { icon: string; name: string }> = {
    google: { icon: '🔵', name: 'Google' },
    github: { icon: '⚫', name: 'GitHub' },
    okta: { icon: '🔷', name: 'Okta' },
    auth0: { icon: '🟠', name: 'Auth0' },
  };
</script>

<div class="login-container">
  <div class="login-card">
    <div class="logo">
      <div class="logo-mark"><span>R</span></div>
      <h1>Rudder</h1>
      <p>Container Management Platform</p>
    </div>

    <form method="POST" use:enhance={() => {
      handleSubmit();
      return async ({ result, update }) => {
        loading = false;
        if (result.type === 'failure') {
          const err = result.data as { error?: string } | undefined;
          errorMessage = err?.error || 'Login failed';
        } else if (result.type === 'redirect') {
          // Handle redirect manually
          window.location.href = result.location;
        } else {
          await update();
        }
      };
    }}>
      {#if errorMessage || form?.error || data?.error}
        <div class="error">{errorMessage || form?.error || data?.error}</div>
      {/if}

      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username" />
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password" />
      </div>

      <button type="submit" disabled={loading} title="Sign in to your account">
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
    </form>

    {#if (data?.oidcProviders && data.oidcProviders.length > 0) || data?.genericOidc}
      <div class="divider">
        <span>or continue with</span>
      </div>

      <div class="oidc-buttons">
        {#each (data.oidcProviders ?? []) as provider}
          {@const style = providerStyles[provider] || { icon: '🔐', name: provider }}
          <a href="/api/auth/oidc/{provider}" class="oidc-button">
            <span class="icon">{style.icon}</span>
            <span>{style.name}</span>
          </a>
        {/each}

        {#if data?.genericOidc}
          <a href="/api/auth/oidc/generic" class="oidc-button oidc-generic">
            <span class="icon">🔐</span>
            <span>Login with {data.genericOidc.providerName}</span>
          </a>
        {/if}
      </div>
    {/if}


  </div>
</div>

<style>
  .login-container {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-root);
    font-family: var(--font-sans);
  }

  .login-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    padding: 40px;
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 400px;
  }

  .logo {
    text-align: center;
    margin-bottom: 32px;
  }

  .logo-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    background: var(--accent);
    border-radius: var(--radius-md);
    margin-bottom: 16px;
  }

  .logo-mark span {
    font-size: 24px;
    font-weight: 700;
    color: var(--bg-root);
    line-height: 1;
  }

  .logo h1 {
    font-size: 24px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .logo p {
    color: var(--text-muted);
    font-size: 13px;
    margin: 0;
  }

  .error {
    background: #dc262618;
    color: #f87171;
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid #dc262630;
    margin-bottom: 20px;
    font-size: 14px;
  }

  .form-group {
    margin-bottom: 20px;
  }

  label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
    font-size: 14px;
    color: var(--text-secondary);
  }

  input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--text-primary);
    font-family: var(--font-sans);
    transition: border-color 0.15s, box-shadow 0.15s;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  input::placeholder {
    color: var(--text-muted);
  }

  button {
    width: 100%;
    padding: 10px 16px;
    background: var(--accent);
    color: var(--bg-root);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-sans);
    cursor: pointer;
    transition: background 0.15s;
    margin-top: 4px;
  }

  button:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .divider {
    display: flex;
    align-items: center;
    margin: 28px 0;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border-default);
  }

  .divider span {
    padding: 0 12px;
    color: var(--text-muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .oidc-buttons {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .oidc-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 14px;
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
    font-family: var(--font-sans);
  }

  .oidc-button .icon {
    font-size: 16px;
  }

  .oidc-button:hover {
    background: var(--bg-raised);
    border-color: var(--text-muted);
  }

  .oidc-generic {
    color: var(--text-primary);
  }
</style>
