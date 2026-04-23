<script lang="ts">
  import { enhance } from '$app/forms';
  import YamlEditor from '$lib/components/YamlEditor.svelte';

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

  interface EnvVar { key: string; value: string; secret: boolean }
  interface PortMapping { containerPort: string; hostPort: string; protocol: string }
  interface VolumeMount { volumeId: string; hostPath: string; containerPath: string; mode: string }

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
  let authType = $state('none');
  let oidcProviderURL = $state('');
  let oidcClientID = $state('');
  let oidcClientSecret = $state('');
  let oidcSessionKey = $state('');
  let oidcCallbackURL = $state('/oauth2/callback');
  let oidcAllowedDomains = $state('');
  let oidcAllowedUsers = $state('');
  let oidcExcludedURLs = $state('');

  let authConfigJson = $derived(authType === 'oidc' ? JSON.stringify({
    providerURL: oidcProviderURL,
    clientID: oidcClientID,
    clientSecret: oidcClientSecret,
    sessionEncryptionKey: oidcSessionKey,
    callbackURL: oidcCallbackURL || '/oauth2/callback',
    allowedUserDomains: oidcAllowedDomains ? oidcAllowedDomains.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
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
      authType = app.authType || 'none';
      if (app.authConfig) {
        try {
          const cfg = JSON.parse(app.authConfig);
          oidcProviderURL = cfg.providerURL || '';
          oidcClientID = cfg.clientID || '';
          oidcClientSecret = cfg.clientSecret || '';
          oidcSessionKey = cfg.sessionEncryptionKey || '';
          oidcCallbackURL = cfg.callbackURL || '/oauth2/callback';
          oidcAllowedDomains = (cfg.allowedUserDomains || []).join(', ');
          oidcAllowedUsers = (cfg.allowedUsers || []).join(', ');
          oidcExcludedURLs = (cfg.excludedURLs || []).join(', ');
        } catch { /* ignore */ }
      }
    }
    if (pm) {
      ports = pm.ports ?? [];
    }
  });

  function addEnvVar() { envVars.push({ key: '', value: '', secret: false }); }
  function removeEnvVar(i: number) { envVars.splice(i, 1); }
  function addPort() { ports.push({ containerPort: '', hostPort: '', protocol: 'tcp' }); }
  function removePort(i: number) { ports.splice(i, 1); }
  function addVolume() { volumeMounts.push({ volumeId: '', hostPath: '', containerPath: '', mode: 'rw' }); }
  function removeVolume(i: number) { volumeMounts.splice(i, 1); }

  function onVolumeSelect(vol: VolumeMount, selectedId: string) {
    vol.volumeId = selectedId;
    if (selectedId) {
      const regVol = data.volumes.find((v: { id: string }) => v.id === selectedId);
      if (regVol) {
        vol.hostPath = regVol.name;
        vol.containerPath = regVol.containerPath;
      }
    } else {
      vol.hostPath = '';
      vol.containerPath = '';
    }
  }

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

<header>
  <a href="/applications/{app.id}" class="back-link">← Back to {app.name}</a>
  <h1>Edit Application</h1>
</header>

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
          <label for="domain">Domain (optional)</label>
          <input type="text" id="domain" name="domain" value={app.domain ?? ''} placeholder="myapp.example.com" />
          <p class="help-text">Leave empty to use auto-generated Traefik subdomain</p>
        </div>
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

      <!-- Environment Variables -->
      <div class="form-section">
        <div class="section-header">
          <h2>Environment Variables</h2>
          <button type="button" class="btn-add" onclick={addEnvVar} title="Add an environment variable">+ Add Variable</button>
        </div>
        {#if envVars.length === 0}
          <p class="empty-hint">No environment variables.</p>
        {:else}
          <div class="kv-list">
            {#each envVars as env, i (i)}
              <div class="kv-row">
                <input type="text" placeholder="VARIABLE_NAME" bind:value={env.key} class="kv-key" />
                <input
                  type={env.secret ? 'password' : 'text'}
                  placeholder="value"
                  bind:value={env.value}
                  class="kv-value"
                />
                <label class="secret-toggle" title="Mark as secret">
                  <input type="checkbox" bind:checked={env.secret} />
                  <span>🔒</span>
                </label>
                <button type="button" class="btn-remove" onclick={() => removeEnvVar(i)} title="Remove this variable">✕</button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Port Mappings -->
      <div class="form-section">
        <div class="section-header">
          <h2>Port Mappings</h2>
          <button type="button" class="btn-add" onclick={addPort} title="Add a port mapping">+ Add Port</button>
        </div>
        {#if ports.length === 0}
          <p class="empty-hint">No explicit port mappings. App accessible via Traefik only.</p>
        {:else}
          <div class="ports-header">
            <span>Container Port</span><span>Host Port</span><span>Protocol</span><span></span>
          </div>
          {#each ports as port, i (i)}
            <div class="port-row">
              <input type="text" placeholder="80" bind:value={port.containerPort} />
              <input type="text" placeholder="auto" bind:value={port.hostPort} />
              <select bind:value={port.protocol}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
              <button type="button" class="btn-remove" onclick={() => removePort(i)} title="Remove this port mapping">✕</button>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Volume Mounts -->
      <div class="form-section">
        <div class="section-header">
          <h2>Volume Mounts</h2>
          <button type="button" class="btn-add" onclick={addVolume} title="Add a volume mount">+ Add Volume</button>
        </div>
        {#if volumeMounts.length === 0}
          <p class="empty-hint">No volume mounts.</p>
        {:else}
          <div class="volumes-header">
            <span>Volume</span><span>Host Path</span><span>Container Path</span><span>Mode</span><span></span>
          </div>
          {#each volumeMounts as vol, i (i)}
            <div class="volume-row">
              <select bind:value={vol.volumeId} onchange={(e) => onVolumeSelect(vol, (e.target as HTMLSelectElement).value)}>
                <option value="">Custom</option>
                {#each data.volumes as regVol}
                  <option value={regVol.id}>{regVol.name}</option>
                {/each}
              </select>
              <input type="text" placeholder="/data/myapp" bind:value={vol.hostPath} disabled={!!vol.volumeId} />
              <input type="text" placeholder="/app/data" bind:value={vol.containerPath} disabled={!!vol.volumeId} />
              <select bind:value={vol.mode}>
                <option value="rw">Read/Write</option>
                <option value="ro">Read Only</option>
              </select>
              <button type="button" class="btn-remove" onclick={() => removeVolume(i)} title="Remove this volume mount">✕</button>
            </div>
          {/each}
        {/if}
      </div>

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
                <span class="error-msg">{err.message}</span>
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
          <option value="none">None (public access)</option>
          <option value="oidc">OIDC / OAuth 2.0</option>
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
              <input type="text" id="oidcCallbackURL" placeholder="/oauth2/callback" bind:value={oidcCallbackURL} />
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
            <input type="password" id="oidcSessionKey" placeholder="at least 32 characters" bind:value={oidcSessionKey} required minlength="32" />
            <p class="help-text">Used to encrypt session cookies. Must be at least 32 characters.</p>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="oidcAllowedDomains">Allowed Email Domains</label>
              <input type="text" id="oidcAllowedDomains" placeholder="company.com, subsidiary.com" bind:value={oidcAllowedDomains} />
              <p class="help-text">Comma-separated. Leave empty to allow all domains.</p>
            </div>
            <div class="form-group">
              <label for="oidcAllowedUsers">Allowed Users</label>
              <input type="text" id="oidcAllowedUsers" placeholder="user@company.com, admin@company.com" bind:value={oidcAllowedUsers} />
              <p class="help-text">Comma-separated email addresses. Leave empty to allow all.</p>
            </div>
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
      <a href="/applications/{app.id}" class="btn-secondary">Cancel</a>
      <button type="submit" class="btn-primary" disabled={loading || manifestErrors.length > 0} title="Save application changes">
        {loading ? 'Saving…' : 'Save Changes'}
      </button>
    </div>
  </form>
</div>

<style>
  .source-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    overflow: hidden;
    width: fit-content;
  }

  .source-btn {
    padding: 8px 20px;
    background: var(--bg-input);
    color: var(--text-muted);
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .source-btn:not(:last-child) {
    border-right: 1px solid var(--border-default);
  }

  .source-btn.active {
    background: var(--accent);
    color: var(--text-inverse);
  }

  .source-btn:hover:not(.active) {
    background: var(--bg-hover);
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 24px;
  }

  .back-link {
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 0.15s;
  }

  .back-link:hover {
    color: var(--text-secondary);
  }

  header h1 {
    font-size: 26px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
    margin: 0;
  }

  .form-container {
    background: var(--bg-raised);
    padding: 30px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
  }

  .form-section {
    margin-bottom: 32px;
    padding-bottom: 32px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .form-section:last-of-type {
    border-bottom: none;
  }

  .form-section h2 {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 16px;
    color: var(--text-muted);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .section-header h2 {
    margin-bottom: 0;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .required {
    color: var(--red);
  }

  .form-group input[type='text'],
  .form-group select,
  .disabled-input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .form-group input::placeholder {
    color: var(--text-muted);
  }

  .form-group select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239898a8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .disabled-input {
    background: var(--bg-overlay);
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .help-text {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    margin-bottom: 8px;
  }

  .validation-errors {
    margin-top: 8px;
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    background: var(--red-subtle);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 120px;
    overflow-y: auto;
  }

  .validation-error {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
  }

  .error-line {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--red-text);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .error-msg {
    color: var(--text-secondary);
  }

  .empty-hint {
    font-size: 13px;
    color: var(--text-muted);
    font-style: italic;
    padding: 8px 0;
  }

  .kv-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .kv-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto auto;
    gap: 8px;
    align-items: center;
  }

  .kv-key,
  .kv-value {
    padding: 8px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-family: var(--font-mono);
    background: var(--bg-input);
    color: var(--text-primary);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .kv-key::placeholder,
  .kv-value::placeholder {
    color: var(--text-muted);
  }

  .kv-key:focus,
  .kv-value:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .secret-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
    opacity: 0.4;
    transition: opacity 0.15s;
  }

  .secret-toggle input {
    margin: 0;
    accent-color: var(--accent);
  }

  .secret-toggle:has(input:checked) {
    opacity: 1;
  }

  .ports-header,
  .volumes-header {
    display: grid;
    gap: 8px;
    padding: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .ports-header {
    grid-template-columns: 1fr 1fr 100px 32px;
  }

  .port-row {
    display: grid;
    grid-template-columns: 1fr 1fr 100px 32px;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .port-row input,
  .port-row select {
    padding: 8px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-input);
    color: var(--text-primary);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .port-row input::placeholder {
    color: var(--text-muted);
  }

  .port-row input:focus,
  .port-row select:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .volumes-header {
    grid-template-columns: 140px 1fr 1fr 110px 32px;
  }

  .volume-row {
    display: grid;
    grid-template-columns: 140px 1fr 1fr 110px 32px;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .volume-row input,
  .volume-row select {
    padding: 8px 10px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-input);
    color: var(--text-primary);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .volume-row input::placeholder {
    color: var(--text-muted);
  }

  .volume-row input:focus,
  .volume-row select:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .volume-row input:disabled {
    background: var(--bg-overlay);
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .btn-add {
    padding: 6px 14px;
    background: var(--accent-subtle);
    color: var(--accent-text);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-add:hover {
    background: var(--bg-hover);
  }

  .btn-remove {
    width: 32px;
    height: 32px;
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
  }

  .btn-remove:hover {
    background: var(--bg-hover);
  }

  .form-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    padding-top: 20px;
    border-top: 1px solid var(--border-subtle);
  }

  .btn-primary,
  .btn-secondary {
    padding: 10px 24px;
    border-radius: var(--radius-sm);
    font-weight: 500;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    border: none;
    transition: background 0.15s;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--text-inverse);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-overlay);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
  }

  .subsection-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 20px 0 12px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }

  .subsection-title:first-of-type {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }

  .oidc-config {
    margin-top: 12px;
    padding: 16px;
    background: var(--bg-overlay, rgba(0,0,0,0.15));
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }

  .form-group input[type='number'],
  .form-group input[type='url'],
  .form-group input[type='password'] {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.15s;
  }

  .form-group input[type='number']:focus,
  .form-group input[type='url']:focus,
  .form-group input[type='password']:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-15);
  }

  @media (max-width: 600px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
