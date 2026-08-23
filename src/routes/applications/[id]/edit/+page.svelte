<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { enhance } from '$app/forms';
  import YamlEditor from '$lib/components/YamlEditor.svelte';
  import EnvVarEditor from '$lib/components/form/EnvVarEditor.svelte';
  import PortMappingEditor from '$lib/components/form/PortMappingEditor.svelte';
  import VolumeMountEditor from '$lib/components/form/VolumeMountEditor.svelte';
  import type { EnvVar, PortMapping, VolumeMount } from '$lib/components/form/types';

  let { data } = $props();
  let loading = $state(false);

  const app = $derived(data.application);
  const pm = $derived(data.parsedManifest);

  // Source toggle: 'image' or 'git'
  let sourceType = $state<'image' | 'git'>('image');
  let gitRepo = $state('');
  let gitBranch = $state('main');
  let gitDockerfile = $state('Dockerfile');

  // Initialize with defaults, populated via $effect
  let image = $state('');
  let command = $state('');
  let workingDir = $state('');
  let memoryLimit = $state('');
  let cpuLimit = $state('');

  function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  let envVars = $state<EnvVar[]>([]);
  let ports = $state<PortMapping[]>([]);
  let volumeMounts = $state<VolumeMount[]>([]);
  let manifestContent = $state('');
  let manifestErrors = $state<Array<{ message: string; line: number; column: number }>>([]);

  // Replicas
  let replicas = $state(1);

  // Blue/green deploy behaviour. Empty health timeout means the built-in
  // default rather than "no timeout".
  let healthTimeoutSeconds = $state<number | ''>('');
  let retainPreviousMinutes = $state(0);

  // Health Check config
  let hcTestCmd = $state('');
  let hcInterval = $state('30s');
  let hcTimeout = $state('5s');
  let hcRetries = $state(3);
  let hcStartPeriod = $state('10s');

  let healthcheckJson = $derived(hcTestCmd.trim() ? JSON.stringify({
    test: hcTestCmd.trim(),
    interval: hcInterval.trim() || '30s',
    timeout: hcTimeout.trim() || '5s',
    retries: hcRetries || 3,
    startPeriod: hcStartPeriod.trim() || '10s',
  }) : '');

  // Security & Access Control
  let rateLimitAvg = $state('');
  let rateLimitBurst = $state('');
  let authType = $state('global');
  let oidcProviderURL = $state('');
  let oidcClientID = $state('');
  let oidcClientSecret = $state('');
  let oidcSessionKey = $state('');
  let oidcCallbackURL = $state('/oidc/callback');
  let oidcAllowedUsers = $state('');
  let oidcExcludedURLs = $state('');

  let authConfigJson = $derived(authType === 'oidc' ? JSON.stringify({
    providerURL: oidcProviderURL,
    clientID: oidcClientID,
    clientSecret: oidcClientSecret,
    sessionEncryptionKey: oidcSessionKey,
    callbackURL: oidcCallbackURL || '/oidc/callback',
    allowedUsers: oidcAllowedUsers ? oidcAllowedUsers.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    excludedURLs: oidcExcludedURLs ? oidcExcludedURLs.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
  }) : '');

  $effect(() => {
    if (pm) {
      image = pm.image ?? '';
      command = pm.command ?? '';
      workingDir = pm.workingDir ?? '';
      memoryLimit = pm.memoryLimit ?? '';
      cpuLimit = pm.cpuLimit ?? '';
    }
    if (app) {
      envVars = parseJSON(app.environment, []);
      volumeMounts = parseJSON(app.volumes, []);
      manifestContent = app.type !== 'single' ? (app.manifest ?? '') : '';
      // Replicas
      replicas = app.replicas ?? 1;
      // Deploy behaviour
      healthTimeoutSeconds = app.healthTimeoutSeconds ?? '';
      retainPreviousMinutes = app.retainPreviousMinutes ?? 0;
      // Git source
      if (app.gitRepo) {
        sourceType = 'git';
        gitRepo = app.gitRepo;
        gitBranch = app.gitBranch || 'main';
        gitDockerfile = app.gitDockerfile || 'Dockerfile';
      } else {
        sourceType = 'image';
      }
      // Health check
      if (app.healthcheck) {
        try {
          const hc = JSON.parse(app.healthcheck);
          hcTestCmd = hc.test || '';
          hcInterval = hc.interval || '30s';
          hcTimeout = hc.timeout || '5s';
          hcRetries = hc.retries || 3;
          hcStartPeriod = hc.startPeriod || '10s';
        } catch { /* ignore */ }
      }
      // Security fields
      rateLimitAvg = app.rateLimitAvg ? String(app.rateLimitAvg) : '';
      rateLimitBurst = app.rateLimitBurst ? String(app.rateLimitBurst) : '';
      authType = app.authType || 'global';
      if (app.authConfig) {
        try {
          const cfg = JSON.parse(app.authConfig);
          oidcProviderURL = cfg.providerURL || '';
          oidcClientID = cfg.clientID || '';
          oidcClientSecret = cfg.clientSecret || '';
          oidcSessionKey = cfg.sessionEncryptionKey || '';
          oidcCallbackURL = cfg.callbackURL || '/oidc/callback';
          oidcAllowedUsers = (cfg.allowedUsers || []).join(', ');
          oidcExcludedURLs = (cfg.excludedURLs || []).join(', ');
        } catch { /* ignore */ }
      }
    }
    if (pm) {
      ports = pm.ports ?? [];
    }
  });

  function handleManifestValidate(errors: Array<{ message: string; line: number; column: number }>) {
    manifestErrors = errors;
  }

  let envJson = $derived(JSON.stringify(envVars));
  let portsJson = $derived(JSON.stringify(ports));
  let volumesJson = $derived(JSON.stringify(volumeMounts));
  let singleManifestJson = $derived(
    JSON.stringify({ image, command, workingDir, memoryLimit, cpuLimit })
  );
</script>

<PageHeader title="Edit Application" back={{ href: `/applications/${app.id}`, label: `Back to ${app.name}` }} />

<div class="form-container">
  <form
    method="POST"
    use:enhance={() => {
      loading = true;
      return async ({ update }) => {
        await update();
        loading = false;
      };
    }}
  >
    <!-- ── Basic details ─────────────────────────────────────────────────── -->
    <div class="form-section">
      <h2>Application Details</h2>

      <div class="form-row">
        <div class="form-group">
          <label for="name">Application Name <span class="required">*</span></label>
          <input type="text" id="name" name="name" value={app.name} required />
        </div>
        <div class="form-group">
          <label for="appType">Type</label>
          <input id="appType" type="text" value={app.type} disabled class="disabled-input" />
          <p class="help-text">Application type cannot be changed after creation</p>
        </div>
      </div>

      <div class="form-group">
        <label for="description">Description</label>
        <input type="text" id="description" name="description" value={app.description ?? ''} placeholder="Brief description of this application" />
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="teamId">Team <span class="required">*</span></label>
          <select id="teamId" name="teamId" required>
            {#each data.teams as team}
              <option value={team.id} selected={team.id === app.teamId}>{team.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="workerId">Worker <span class="required">*</span></label>
          <select id="workerId" name="workerId" required>
            {#each data.workers as worker}
              <option value={worker.id} selected={worker.id === app.workerId}>
                {worker.name} ({worker.hostname})
              </option>
            {/each}
          </select>
        </div>
      </div>

      {#if app.type === 'single'}
        <div class="form-row">
          <div class="form-group">
            <label for="replicas">Replicas</label>
            <input type="number" id="replicas" name="replicas" bind:value={replicas} min="1" max="10" />
            <p class="help-text">Number of container instances. Traefik load-balances across all replicas.</p>
          </div>
          <div class="form-group"></div>
        </div>
      {/if}

      <div class="form-row">
        <div class="form-group">
          <label for="stackId">Stack (optional)</label>
          <select id="stackId" name="stackId">
            <option value="">No stack</option>
            {#each data.stacks as stack}
              <option value={stack.id} selected={stack.id === app.stackId}>{stack.name}</option>
            {/each}
          </select>
          <p class="help-text">Group this application into a stack for bulk operations</p>
        </div>
      </div>
    </div>

    <!-- ── Single container ──────────────────────────────────────────────── -->
    {#if app.type === 'single'}
      <div class="form-section">
        <h2>Container Source</h2>

        <div class="source-toggle">
          <button type="button" class="source-btn" class:active={sourceType === 'image'} onclick={() => sourceType = 'image'}>Image</button>
          <button type="button" class="source-btn" class:active={sourceType === 'git'} onclick={() => sourceType = 'git'}>Git Repository</button>
        </div>

        {#if sourceType === 'image'}
          <div class="form-group">
            <label for="image">Container Image <span class="required">*</span></label>
            <input
              type="text"
              id="image"
              name="image"
              placeholder="nginx:latest"
              bind:value={image}
              required
            />
          </div>
        {:else}
          <div class="form-group">
            <label for="gitRepo">Git Repository URL <span class="required">*</span></label>
            <input
              type="text"
              id="gitRepo"
              placeholder="https://github.com/user/repo.git"
              bind:value={gitRepo}
              required
            />
            <p class="help-text">HTTPS URL to a public or accessible Git repository</p>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="gitBranch">Branch</label>
              <input type="text" id="gitBranch" placeholder="main" bind:value={gitBranch} />
            </div>
            <div class="form-group">
              <label for="gitDockerfile">Dockerfile Path</label>
              <input type="text" id="gitDockerfile" placeholder="Dockerfile" bind:value={gitDockerfile} />
              <p class="help-text">Path to Dockerfile relative to the repository root</p>
            </div>
          </div>
        {/if}

        <input type="hidden" name="manifest" value={singleManifestJson} />
        <input type="hidden" name="envVars" value={envJson} />
        <input type="hidden" name="ports" value={portsJson} />
        <input type="hidden" name="volumeMounts" value={volumesJson} />
        <input type="hidden" name="healthcheck" value={healthcheckJson} />
        <input type="hidden" name="gitRepo" value={sourceType === 'git' ? gitRepo : ''} />
        <input type="hidden" name="gitBranch" value={sourceType === 'git' ? gitBranch : ''} />
        <input type="hidden" name="gitDockerfile" value={sourceType === 'git' ? gitDockerfile : ''} />
      </div>

      <EnvVarEditor bind:values={envVars} />

      <PortMappingEditor bind:values={ports} />

      <VolumeMountEditor bind:values={volumeMounts} volumes={data.volumes} />

      <!-- Resources & Advanced -->
      <div class="form-section">
        <h2>Resources & Advanced</h2>
        <div class="form-row">
          <div class="form-group">
            <label for="restartPolicy">Restart Policy</label>
            <select id="restartPolicy" name="restartPolicy">
              {#each [['always','Always (recommended)'],['unless-stopped','Unless Stopped'],['on-failure','On Failure'],['no','Never']] as [val, label]}
                <option value={val} selected={val === app.restartPolicy}>{label}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="workingDir">Working Directory</label>
            <input type="text" id="workingDir" placeholder="/app" bind:value={workingDir} />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="memoryLimit">Memory Limit</label>
            <input type="text" id="memoryLimit" placeholder="e.g. 512m, 2g" bind:value={memoryLimit} />
          </div>
          <div class="form-group">
            <label for="cpuLimit">CPU Limit (cores)</label>
            <input type="text" id="cpuLimit" placeholder="e.g. 0.5, 2" bind:value={cpuLimit} />
          </div>
        </div>
        <div class="form-group">
          <label for="command">Command Override</label>
          <input type="text" id="command" placeholder="node server.js" bind:value={command} />
          <p class="help-text">Overrides the default CMD of the container image</p>
        </div>
      </div>

      <!-- Health Check -->
      <div class="form-section">
        <h2>Health Check</h2>
        <p class="help-text">Configure a health check command to monitor container health. Leave test command empty to skip.</p>

        <div class="form-group">
          <label for="hcTestCmd">Test Command</label>
          <input type="text" id="hcTestCmd" placeholder="e.g. curl -f http://localhost:80/health" bind:value={hcTestCmd} />
          <p class="help-text">Command to run inside the container. Exit code 0 = healthy.</p>
        </div>

        {#if hcTestCmd.trim()}
          <div class="form-row">
            <div class="form-group">
              <label for="hcInterval">Interval</label>
              <input type="text" id="hcInterval" placeholder="30s" bind:value={hcInterval} />
              <p class="help-text">Time between health checks (e.g. 30s, 1m)</p>
            </div>
            <div class="form-group">
              <label for="hcTimeout">Timeout</label>
              <input type="text" id="hcTimeout" placeholder="5s" bind:value={hcTimeout} />
              <p class="help-text">Max time for command to complete</p>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="hcRetries">Retries</label>
              <input type="number" id="hcRetries" bind:value={hcRetries} min="1" max="20" />
              <p class="help-text">Consecutive failures before marking unhealthy</p>
            </div>
            <div class="form-group">
              <label for="hcStartPeriod">Start Period</label>
              <input type="text" id="hcStartPeriod" placeholder="10s" bind:value={hcStartPeriod} />
              <p class="help-text">Grace period before health checks start</p>
            </div>
          </div>
        {/if}
      </div>

    {:else}
      <!-- Compose / K8s manifest -->
      <div class="form-section">
        <h2>Manifest</h2>
        <input type="hidden" name="manifest" value={manifestContent} />
        <YamlEditor bind:value={manifestContent} onValidate={handleManifestValidate} />
        {#if manifestErrors.length > 0}
          <div class="validation-errors">
            {#each manifestErrors as err}
              <div class="validation-error">
                <span class="error-line">Ln {err.line}:{err.column}</span>
                <span class="error-text">{err.message}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="form-section">
        <h2>Restart Policy</h2>
        <div class="form-group">
          <select name="restartPolicy">
            {#each [['always','Always (recommended)'],['unless-stopped','Unless Stopped'],['on-failure','On Failure'],['no','Never']] as [val, label]}
              <option value={val} selected={val === app.restartPolicy}>{label}</option>
            {/each}
          </select>
        </div>
      </div>
    {/if}

    <!-- ── Deploy behaviour (all app types) ───────────────────── -->
    <div class="form-section">
      <h2>Deploy Behaviour</h2>
      <p class="help-text">
        On workers using control-plane routing, a deploy creates the new containers alongside the
        running ones and only moves traffic once they are up. These settings control that changeover.
      </p>
      <div class="form-row">
        <div class="form-group">
          <label for="healthTimeoutSeconds">Health timeout (seconds)</label>
          <input
            type="number" id="healthTimeoutSeconds" name="healthTimeoutSeconds"
            bind:value={healthTimeoutSeconds} min="10" max="3600" placeholder="120"
          />
          <p class="help-text">
            How long to wait for the new containers before abandoning the deploy. The previous
            version keeps serving throughout, and stays serving if the wait runs out.
          </p>
        </div>
        <div class="form-group">
          <label for="retainPreviousMinutes">Keep previous version (minutes)</label>
          <input
            type="number" id="retainPreviousMinutes" name="retainPreviousMinutes"
            bind:value={retainPreviousMinutes} min="0" max="1440"
          />
          <p class="help-text">
            Leave the superseded containers stopped but present for this long, so a rollback to that
            version restarts them instead of pulling and recreating. 0 removes them at the end of the
            deploy. They keep holding their host ports while retained.
          </p>
        </div>
      </div>
    </div>

    <!-- ── Security & Access Control (all app types) ──────────── -->
    <div class="form-section">
      <h2>Security & Access Control</h2>
      <p class="help-text">Rate limiting and authentication are applied at the Traefik reverse proxy level, before requests reach your application.</p>

      <input type="hidden" name="rateLimitAvg" value={rateLimitAvg} />
      <input type="hidden" name="rateLimitBurst" value={rateLimitBurst} />
      <input type="hidden" name="authType" value={authType} />
      <input type="hidden" name="authConfig" value={authConfigJson} />

      <h3 class="subsection-title">Rate Limiting</h3>
      <div class="form-row">
        <div class="form-group">
          <label for="rateLimitAvg">Requests / second (average)</label>
          <input type="number" id="rateLimitAvg" placeholder="e.g. 100 (empty = no limit)" bind:value={rateLimitAvg} min="1" />
          <p class="help-text">Average number of requests per second allowed per client IP</p>
        </div>
        <div class="form-group">
          <label for="rateLimitBurst">Burst size</label>
          <input type="number" id="rateLimitBurst" placeholder="e.g. 200 (default: 2x average)" bind:value={rateLimitBurst} min="1" />
          <p class="help-text">Maximum burst of requests allowed above the average rate</p>
        </div>
      </div>

      <h3 class="subsection-title">Authentication</h3>
      <div class="form-group">
        <label for="authType">Auth Type</label>
        <select id="authType" bind:value={authType}>
          <option value="global">Default (Global OIDC if configured)</option>
          <option value="none">None (public access)</option>
          <option value="oidc">Custom OIDC / OAuth 2.0</option>
        </select>
        <p class="help-text">Require users to authenticate via an identity provider before accessing this application</p>
      </div>

      {#if authType === 'oidc'}
        <div class="oidc-config">
          <div class="form-row">
            <div class="form-group">
              <label for="oidcProviderURL">Provider URL <span class="required">*</span></label>
              <input type="url" id="oidcProviderURL" placeholder="https://accounts.google.com" bind:value={oidcProviderURL} required />
              <p class="help-text">OIDC discovery endpoint (e.g. Google, Azure AD, Okta, Keycloak)</p>
            </div>
            <div class="form-group">
              <label for="oidcCallbackURL">Callback Path</label>
              <input type="text" id="oidcCallbackURL" placeholder="/oidc/callback" bind:value={oidcCallbackURL} />
              <p class="help-text">Path on this app's own host. Register it as a redirect URI with your provider.</p>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="oidcClientID">Client ID <span class="required">*</span></label>
              <input type="text" id="oidcClientID" placeholder="your-client-id" bind:value={oidcClientID} required />
            </div>
            <div class="form-group">
              <label for="oidcClientSecret">Client Secret <span class="required">*</span></label>
              <input type="password" id="oidcClientSecret" placeholder="your-client-secret" bind:value={oidcClientSecret} required />
            </div>
          </div>
          <div class="form-group">
            <label for="oidcSessionKey">Session Encryption Key <span class="required">*</span></label>
            <input type="password" id="oidcSessionKey" placeholder="exactly 32 characters" bind:value={oidcSessionKey} required minlength="32" maxlength="32" />
            <p class="help-text">Used to encrypt session cookies. Must be exactly 32 characters — the Traefik plugin uses it directly as an AES-256 key.</p>
          </div>
          <div class="form-group">
            <label for="oidcAllowedUsers">Allowed Users</label>
            <input type="text" id="oidcAllowedUsers" placeholder="user@company.com, admin@company.com" bind:value={oidcAllowedUsers} />
            <p class="help-text">
              Comma-separated email addresses. Leave empty to allow anyone your identity provider authenticates.
              Whole-domain rules are not available: the plugin compares claims by exact value, so restrict by
              domain at the identity provider instead.
            </p>
          </div>
          <div class="form-group">
            <label for="oidcExcludedURLs">Public Paths (bypass auth)</label>
            <input type="text" id="oidcExcludedURLs" placeholder="/health, /api/public, /metrics" bind:value={oidcExcludedURLs} />
            <p class="help-text">Comma-separated paths that should not require authentication</p>
          </div>
        </div>
      {/if}
    </div>

    <div class="form-actions">
      <a href="/applications/{app.id}" class="btn-secondary btn-lg">Cancel</a>
      <button type="submit" class="btn-primary btn-lg" disabled={loading || manifestErrors.length > 0} title="Save application changes">
        {loading ? 'Saving…' : 'Save Changes'}
      </button>
    </div>
  </form>
</div>

<style>
  /* Not an input, but has to look like one. The real inputs are styled by the
  shared sheet; this borrows the same values. */
  .disabled-input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
  }

  .disabled-input {
    background: var(--bg-overlay);
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .help-text {
    margin-bottom: 8px;
  }

  .error-text {
    color: var(--text-secondary);
  }

  .oidc-config {
    margin-top: 12px;
    padding: 16px;
    background: var(--bg-overlay, rgba(0,0,0,0.15));
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }

  @media (max-width: 600px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
