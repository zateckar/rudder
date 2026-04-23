<script lang="ts">
  import { enhance } from '$app/forms';

  let { data, form } = $props();
  const cfg = $derived(data.config);

  // Form fields — initialize with defaults, then populated from cfg
  let enabled = $state(false);
  let providerName = $state('Generic OIDC');
  let issuerUrl = $state('');
  let clientId = $state('');
  let clientSecret = $state('');
  let authorizationEndpoint = $state('');
  let tokenEndpoint = $state('');
  let userinfoEndpoint = $state('');
  let jwksUri = $state('');
  let scopes = $state('openid email profile');
  let usePkce = $state(true);
  let allowRegistration = $state(true);
  let teamClaimName = $state('');
  let teamClaimKey = $state('');

  $effect(() => {
    if (cfg) {
      enabled = cfg.enabled ?? false;
      providerName = cfg.providerName ?? 'Generic OIDC';
      issuerUrl = cfg.issuerUrl ?? '';
      clientId = cfg.clientId ?? '';
      clientSecret = cfg.clientSecret ?? '';
      authorizationEndpoint = cfg.authorizationEndpoint ?? '';
      tokenEndpoint = cfg.tokenEndpoint ?? '';
      userinfoEndpoint = cfg.userinfoEndpoint ?? '';
      jwksUri = cfg.jwksUri ?? '';
      scopes = cfg.scopes ?? 'openid email profile';
      usePkce = cfg.usePkce ?? true;
      allowRegistration = cfg.allowRegistration ?? true;
      teamClaimName = cfg.teamClaimName ?? '';
      teamClaimKey = cfg.teamClaimKey ?? '';
    }
  });

  let saving = $state(false);
  let discovering = $state(false);

  $effect(() => {
    // Auto-fill from discovery result
    if ((form as any)?.discovered) {
      const d = (form as any).discovered;
      authorizationEndpoint = d.authorizationEndpoint || authorizationEndpoint;
      tokenEndpoint = d.tokenEndpoint || tokenEndpoint;
      userinfoEndpoint = d.userinfoEndpoint || userinfoEndpoint;
      jwksUri = d.jwksUri || jwksUri;
    }
  });
</script>

<header>
  <h1>OIDC Configuration</h1>
  <p class="subtitle">Configure a generic OpenID Connect provider for single sign-on (Auth Code + PKCE)</p>
</header>

{#if (form as any)?.success}
  <div class="alert success">✓ Configuration saved successfully</div>
{/if}
{#if (form as any)?.error}
  <div class="alert error">✕ {(form as any).error}</div>
{/if}

<!-- Callback URL info box -->
<div class="info-box">
  <strong>Callback URL</strong> — Register this in your OIDC provider:
  <code class="callback-url">{data.callbackUrl}</code>
</div>

<div class="form-container">
  <form method="POST" action="?/save" use:enhance={() => {
    saving = true;
    return async ({ update }) => { await update(); saving = false; };
  }}>

    <!-- Enable toggle -->
    <div class="form-section">
      <div class="toggle-row">
        <div>
          <h2>Enable Generic OIDC</h2>
          <p class="section-desc">Allow users to log in with an external OIDC provider</p>
        </div>
        <label class="toggle">
          <input type="checkbox" name="enabled" bind:checked={enabled} />
          <span class="slider"></span>
        </label>
      </div>
    </div>

    {#if enabled}
      <!-- Provider Details -->
      <div class="form-section">
        <h2>Provider Settings</h2>

        <div class="form-group">
          <label for="providerName">Display Name</label>
          <input type="text" id="providerName" name="providerName" bind:value={providerName}
            placeholder="e.g. Keycloak, Auth0, Okta…" />
          <p class="help">Shown on the login button: "Login with {providerName}"</p>
        </div>

        <div class="form-group">
          <label for="issuerUrl">Issuer URL</label>
          <div class="input-row">
            <input type="url" id="issuerUrl" name="issuerUrl" bind:value={issuerUrl}
              placeholder="https://auth.example.com/realms/myrealm" />
            <input type="hidden" name="issuerUrl" formaction="?/discover" value={issuerUrl} />
            <button type="submit" formaction="?/discover" class="btn-discover" disabled={!issuerUrl || discovering}
              onclick={() => discovering = true}>
              {discovering ? 'Discovering…' : '⚡ Auto-discover'}
            </button>
          </div>
          <p class="help">Used for OIDC Discovery. Click "Auto-discover" to populate the endpoints below automatically.</p>
        </div>

        <div class="form-group">
          <label for="clientId">Client ID <span class="required">*</span></label>
          <input type="text" id="clientId" name="clientId" bind:value={clientId}
            placeholder="my-app-client-id" required={enabled} />
        </div>

        <div class="form-group">
          <label for="clientSecret">Client Secret</label>
          <input type="password" id="clientSecret" name="clientSecret" bind:value={clientSecret}
            placeholder="Leave empty for public client (PKCE only)" autocomplete="new-password" />
          <p class="help">Optional when using PKCE. Required for confidential clients.</p>
        </div>

        <div class="form-group">
          <label for="scopes">Scopes</label>
          <input type="text" id="scopes" name="scopes" bind:value={scopes}
            placeholder="openid email profile" />
        </div>
      </div>

      <!-- Endpoints -->
      <div class="form-section">
        <h2>Endpoints</h2>
        <p class="section-desc">These are filled automatically by Auto-discover, or enter manually.</p>

        <div class="form-group">
          <label for="authorizationEndpoint">Authorization Endpoint <span class="required">*</span></label>
          <input type="url" id="authorizationEndpoint" name="authorizationEndpoint"
            bind:value={authorizationEndpoint} placeholder="https://…/authorize" required={enabled} />
        </div>

        <div class="form-group">
          <label for="tokenEndpoint">Token Endpoint <span class="required">*</span></label>
          <input type="url" id="tokenEndpoint" name="tokenEndpoint"
            bind:value={tokenEndpoint} placeholder="https://…/token" required={enabled} />
        </div>

        <div class="form-group">
          <label for="userinfoEndpoint">Userinfo Endpoint <span class="required">*</span></label>
          <input type="url" id="userinfoEndpoint" name="userinfoEndpoint"
            bind:value={userinfoEndpoint} placeholder="https://…/userinfo" required={enabled} />
        </div>

        <div class="form-group">
          <label for="jwksUri">JWKS URI</label>
          <input type="url" id="jwksUri" name="jwksUri"
            bind:value={jwksUri} placeholder="https://…/jwks" />
        </div>
      </div>

      <!-- Security & Registration -->
      <div class="form-section">
        <h2>Security & Registration</h2>

        <div class="checkbox-row">
          <label class="checkbox-label">
            <input type="checkbox" name="usePkce" bind:checked={usePkce} />
            <div>
              <span class="cb-title">Use PKCE (Proof Key for Code Exchange)</span>
              <span class="cb-desc">Recommended for all clients. Required for public clients without a client secret.</span>
            </div>
          </label>
        </div>

        <div class="checkbox-row">
          <label class="checkbox-label">
            <input type="checkbox" name="allowRegistration" bind:checked={allowRegistration} />
            <div>
              <span class="cb-title">Allow Registration via OIDC</span>
              <span class="cb-desc">Create a new Rudder account when a user logs in for the first time via OIDC.</span>
            </div>
          </label>
        </div>
      </div>

      <!-- Team Sync -->
      <div class="form-section">
        <h2>Team Synchronization</h2>
        <p class="section-desc">Automatically create teams and assign users based on OIDC claims.</p>

        <div class="form-group">
          <label for="teamClaimName">Team Claim Name</label>
          <input type="text" id="teamClaimName" name="teamClaimName" bind:value={teamClaimName}
            placeholder="e.g. apps_with_role" />
          <p class="help">The name of the claim in the access token or userinfo that contains team assignments.</p>
        </div>

        <div class="form-group">
          <label for="teamClaimKey">Team Claim Key</label>
          <input type="text" id="teamClaimKey" name="teamClaimKey" bind:value={teamClaimKey}
            placeholder="e.g. API.DEVELOPERS" />
          <p class="help">The key inside the claim object that contains the array of team names. Leave empty if the claim is already an array.</p>
        </div>

        <div class="example-box">
          <strong>Example:</strong> If your claim looks like <code>&#123;"API.DEVELOPERS": ["TEAM-A", "TEAM-B"]&#125;</code>:
          <ul>
            <li>Team Claim Name: <code>apps_with_role</code> (the claim name in the token)</li>
            <li>Team Claim Key: <code>API.DEVELOPERS</code> (the key inside the claim)</li>
          </ul>
          Users will be automatically added to teams TEAM-A and TEAM-B. Teams are created if they don't exist.
        </div>
      </div>
    {/if}

    <div class="form-actions">
      <button type="submit" class="btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save Configuration'}
      </button>
    </div>
  </form>

  {#if cfg?.enabled}
    <div class="test-section">
      <h3>Test</h3>
      <p>Open a new incognito window and visit the login page to test the OIDC flow.</p>
      <a href="/login" target="_blank" class="btn-secondary">Open Login Page ↗</a>
    </div>
  {/if}
</div>

<style>
  header { margin-bottom: 24px; }
  header h1 { font-size: 26px; color: var(--text-primary); margin: 0 0 6px; }
  .subtitle { color: var(--text-secondary); font-size: 14px; }

  .alert {
    padding: 12px 16px; border-radius: var(--radius-md); margin-bottom: 16px;
    font-size: 14px; font-weight: 500;
  }
  .alert.success { background: var(--green-subtle); color: var(--green-text); border: 1px solid var(--green); }
  .alert.error   { background: var(--red-subtle); color: var(--red-text); border: 1px solid var(--red); }

  .info-box {
    background: var(--blue-subtle); border: 1px solid var(--blue); border-radius: var(--radius-md);
    padding: 14px 18px; margin-bottom: 20px; font-size: 13px; color: var(--text-primary);
  }
  .callback-url {
    display: block; margin-top: 6px; font-family: var(--font-mono); font-size: 13px;
    background: var(--bg-input); color: var(--text-primary); padding: 8px 12px;
    border-radius: var(--radius-sm); border: 1px solid var(--border-default);
    word-break: break-all; user-select: all;
  }

  .form-container {
    background: var(--bg-raised); padding: 30px; border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
  }

  .form-section {
    margin-bottom: 32px; padding-bottom: 32px; border-bottom: 1px solid var(--border-subtle);
  }
  .form-section:last-of-type { border-bottom: none; }
  .form-section h2 { font-size: 15px; font-weight: 600; margin-bottom: 6px; color: var(--text-primary); }
  .section-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }

  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
  }

  /* Toggle switch */
  .toggle { position: relative; display: inline-block; width: 48px; height: 26px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; inset: 0; background: var(--bg-active); border-radius: 26px; cursor: pointer;
    transition: background 0.2s;
  }
  .slider::before {
    content: ''; position: absolute; width: 20px; height: 20px;
    left: 3px; bottom: 3px; background: var(--text-secondary); border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle input:checked + .slider { background: var(--accent); }
  .toggle input:checked + .slider::before { background: var(--text-inverse); transform: translateX(22px); }

  .form-group { margin-bottom: 18px; }
  .form-group label {
    display: block; margin-bottom: 6px; font-weight: 500; font-size: 13px; color: var(--text-primary);
  }
  .required { color: var(--red); }
  .form-group input[type='text'],
  .form-group input[type='url'],
  .form-group input[type='password'] {
    width: 100%; padding: 9px 12px; border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); font-size: 14px; background: var(--bg-input);
    color: var(--text-primary); box-sizing: border-box; transition: border-color 0.15s;
  }
  .form-group input:focus { outline: none; border-color: var(--border-focus); }
  .help { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

  .input-row { display: flex; gap: 8px; align-items: stretch; }
  .input-row input { flex: 1; }

  .btn-discover {
    padding: 0 14px; background: var(--accent-subtle); color: var(--accent-text);
    border: 1px solid var(--accent); border-radius: var(--radius-sm); font-size: 12px;
    font-weight: 500; cursor: pointer; white-space: nowrap; transition: background 0.15s;
  }
  .btn-discover:hover:not(:disabled) { background: var(--bg-hover); }
  .btn-discover:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Checkboxes */
  .checkbox-row { margin-bottom: 16px; }
  .checkbox-label {
    display: flex; align-items: flex-start; gap: 12px; cursor: pointer;
  }
  .checkbox-label input[type='checkbox'] { margin-top: 2px; flex-shrink: 0; accent-color: var(--accent); }
  .cb-title { display: block; font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .cb-desc { display: block; font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

  /* Actions */
  .form-actions {
    display: flex; justify-content: flex-end;
    padding-top: 20px; border-top: 1px solid var(--border-subtle);
  }
  .btn-primary {
    padding: 10px 24px; background: var(--accent); color: var(--text-inverse);
    border: none; border-radius: var(--radius-sm); font-size: 14px; font-weight: 500;
    cursor: pointer; transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

  .test-section {
    margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border-subtle);
  }
  .test-section h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: var(--text-primary); }
  .test-section p { font-size: 13px; color: var(--text-secondary); margin-bottom: 10px; }
  .btn-secondary {
    display: inline-block; padding: 8px 16px; background: var(--bg-raised); color: var(--text-primary);
    border: 1px solid var(--border-default); border-radius: var(--radius-sm); font-size: 13px;
    text-decoration: none; transition: background 0.15s;
  }
  .btn-secondary:hover { background: var(--bg-hover); }

  .example-box {
    background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    padding: 12px 14px; font-size: 12px; color: var(--text-secondary); margin-top: 12px;
  }
  .example-box strong { color: var(--text-primary); }
  .example-box code {
    background: var(--bg-input); padding: 2px 5px; border-radius: 3px;
    font-family: var(--font-mono); font-size: 11px; color: var(--accent-text);
  }
  .example-box ul { margin: 8px 0 0; padding-left: 18px; }
  .example-box li { margin-bottom: 4px; }
</style>
