<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { formatBytes } from '$lib/format';
  import { enhance } from '$app/forms';
  import YamlEditor from '$lib/components/YamlEditor.svelte';
  import EnvVarEditor from '$lib/components/form/EnvVarEditor.svelte';
  import PortMappingEditor from '$lib/components/form/PortMappingEditor.svelte';
  import VolumeMountEditor from '$lib/components/form/VolumeMountEditor.svelte';
  import type { EnvVar, PortMapping, VolumeMount } from '$lib/components/form/types';

  let { data } = $props();
  let loading = $state(false);
  let appType = $state('single');
  let manifestContent = $state('');
  let manifestErrors = $state<Array<{ message: string; line: number; column: number }>>([]);
  let appName = $state('');

  // Source toggle: 'image' or 'git'
  let sourceType = $state<'image' | 'git'>('image');
  let gitRepo = $state('');
  let gitBranch = $state('main');
  let gitDockerfile = $state('Dockerfile');

  // Single container config
  let image = $state('');
  let command = $state('');
  let workingDir = $state('');
  let memoryLimit = $state('');
  let cpuLimit = $state('');

  let envVars = $state<EnvVar[]>([]);
  let ports = $state<PortMapping[]>([]);
  let volumeMounts = $state<VolumeMount[]>([]);

  // Replicas (single container only)
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
  let authType = $state('global');
  let oidcProviderURL = $state('');
  let oidcClientID = $state('');
  let oidcClientSecret = $state('');
  let oidcSessionKey = $state('');
  let oidcCallbackURL = $state('/oidc/callback');
  let oidcAllowedUsers = $state('');
  let oidcExcludedURLs = $state('');
  // Worker-level OIDC only: names of the headers the shared middleware should
  // deliver this application's tokens under. Empty means "do not send it".
  let oidcIdTokenHeader = $state('');
  let oidcAccessTokenHeader = $state('');

  let authConfigJson = $derived(authType === 'oidc' ? JSON.stringify({
    providerURL: oidcProviderURL,
    clientID: oidcClientID,
    clientSecret: oidcClientSecret,
    sessionEncryptionKey: oidcSessionKey,
    callbackURL: oidcCallbackURL || '/oidc/callback',
    allowedUsers: oidcAllowedUsers ? oidcAllowedUsers.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    excludedURLs: oidcExcludedURLs ? oidcExcludedURLs.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
  }) : '');

  // Auto-selected worker
  let selectedWorker = $derived(data.selectedWorker);
  let previewDomain = $derived(
    appName && selectedWorker?.baseDomain
      ? `${appName}.${selectedWorker.baseDomain}`
      : null
  );

  const composeExample = `# Host ports are allocated by Rudder — the left-hand number in "80:8080" is
# ignored, so two applications can both want 8080. Traefik does the routing.
services:
  web:
    image: nginx:latest
    ports:
      - "8080"
      - "9090"
    # Which of this service's ports are public, in order: 8080 on :443, 9090 on
    # :1443, same hostname and certificate. Omit the label and only the first
    # published port is served. Ports left out stay reachable from sibling
    # services by name (http://web:9090) but not from outside.
    labels:
      rudder.expose: "8080,9090"
    restart: always
    environment:
      APP_ENV: production
      DATABASE_URL: \${DATABASE_URL}
    volumes:
      - app-data:/var/www/html
      - ./config/nginx.conf:/etc/nginx/nginx.conf:ro
    networks:
      - frontend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

  # A second service gets its own hostname — web-api.<base> — so it does not
  # need an extra port at all. Reach for rudder.expose when one container
  # serves several things and they have to share a hostname.
  api:
    image: nginx:latest
    ports:
      - "3000"
    restart: always
    networks:
      - frontend

volumes:
  app-data:
    driver: local

networks:
  frontend:
    driver: bridge
`;

  const k8sExample = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  labels:
    app: my-app
  annotations:
    # Which container ports are public, in order: 8080 on :443, 9090 on :1443,
    # same hostname and certificate. Omit it and only the first published port
    # is served; the rest stay reachable inside the application's own network.
    # A kubectl apply carrying this annotation overwrites the UI field.
    rudder.dev/expose-ports: "8080,9090"
    # Optional: rudder.dev/worker pins the target worker, rudder.dev/domain
    # sets an explicit hostname instead of <app>.<base>.
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          # Host ports are allocated by Rudder; these are the ports inside the
          # container, and the ones the annotation above names.
          ports:
            - containerPort: 8080
            - containerPort: 9090
          env:
            - name: APP_ENV
              value: production
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: database-url
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 512Mi
          volumeMounts:
            - name: cache
              mountPath: /var/cache/nginx
            # A whole volume, not a subPath — Rudder mounts volumes, not single
            # files out of them, so each ConfigMap key lands as a file here.
            - name: config
              mountPath: /etc/nginx/conf.d
              readOnly: true
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        # emptyDir, configMap and secret work as written. A hostPath works too,
        # but only under a prefix an operator has allow-listed on the worker.
        # There is no persistentVolumeClaim: Rudder has no storage layer behind
        # one, and a manifest using it is refused at deploy time rather than
        # deployed with the mount quietly missing.
        - name: cache
          emptyDir:
            sizeLimit: 64Mi
        - name: config
          configMap:
            name: my-app-config
---
apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-app-config
data:
  default.conf: |
    server {
      listen 8080;
      location /health { return 200 "ok"; }
    }
    server {
      listen 9090;
      location / { return 200 "admin"; }
    }
---
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
stringData:
  database-url: postgres://user:pass@db:5432/myapp
`;

  let lastLoadedType = $state('');

  $effect(() => {
    if (appType === 'compose' || appType === 'k8s') {
      if (lastLoadedType !== appType) {
        manifestContent = appType === 'compose' ? composeExample.trim() : k8sExample.trim();
        lastLoadedType = appType;
      }
    } else {
      lastLoadedType = '';
    }
  });

  function handleManifestValidate(errors: Array<{ message: string; line: number; column: number }>) {
    manifestErrors = errors;
  }

  // Serialised JSON hidden inputs for single container
  let envJson = $derived(JSON.stringify(envVars));
  let portsJson = $derived(JSON.stringify(ports));
  let volumesJson = $derived(JSON.stringify(volumeMounts));
  let singleManifestJson = $derived(
    JSON.stringify({ image, command, workingDir, memoryLimit, cpuLimit })
  );
</script>

<PageHeader title="New Application" />

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
    <!-- ── Basic details ─────────────────────────────────────── -->
    <div class="form-section">
      <h2>Application Details</h2>

      <div class="form-row">
        <div class="form-group">
          <label for="name">Application Name <span class="required">*</span></label>
          <input type="text" id="name" name="name" placeholder="my-app" required />
        </div>

        <div class="form-group">
          <label for="type">Type <span class="required">*</span></label>
          <select id="type" name="type" bind:value={appType}>
            <option value="single">Single Container</option>
            <option value="compose">Docker Compose</option>
            <option value="k8s">Kubernetes Manifest</option>
          </select>
        </div>
      </div>

      {#if appType === 'single'}
        <div class="form-row">
          <div class="form-group">
            <label for="replicas">Replicas</label>
            <input type="number" id="replicas" name="replicas" bind:value={replicas} min="1" max="10" />
            <p class="help-text">Number of container instances. Traefik load-balances across all replicas.</p>
          </div>
          <div class="form-group"></div>
        </div>
      {/if}

      <div class="form-group">
        <label for="description">Description</label>
        <input type="text" id="description" name="description" placeholder="Brief description of this application" />
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="teamId">Team <span class="required">*</span></label>
          <select id="teamId" name="teamId" required>
            <option value="">Select a team…</option>
            {#each data.teams as team}
              <option value={team.id}>{team.name}</option>
            {/each}
          </select>
        </div>

        <div class="form-group">
          <label for="workerId">Worker</label>
          {#if data.noWorkersAvailable}
            <div class="no-worker-banner">
              <p class="no-worker-title">No workers with sufficient resources</p>
              <p class="no-worker-hint">All workers are above 85% utilization or offline. Contact an admin to add capacity.</p>
            </div>
          {:else}
            <select id="workerId" name="workerId" class="worker-select">
              {#each data.allWorkers as w}
                <option value={w.worker.id} selected={w.worker.id === selectedWorker?.id}>
                  {w.worker.name} — {w.worker.baseDomain}
                  {w.worker.id === selectedWorker?.id ? ' (recommended)' : ''}
                </option>
              {/each}
            </select>
          {/if}
        </div>
      </div>

      {#if previewDomain}
        <div class="domain-preview">
          <span class="domain-label">URL:</span>
          <code class="domain-value">https://{previewDomain}</code>
        </div>
      {/if}
    </div>

    <!-- ── Single container ───────────────────────────────────── -->
    {#if appType === 'single'}
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
            <p class="help-text">Docker Hub short names (e.g. nginx), full registry paths, or tagged images</p>
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

        <!-- Hidden serialised payload consumed by the server action -->
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

      <!-- Resource Limits & Advanced -->
      <div class="form-section">
        <h2>Resources & Advanced</h2>

        <div class="form-row">
          <div class="form-group">
            <label for="restartPolicy">Restart Policy</label>
            <select id="restartPolicy" name="restartPolicy">
              <option value="always">Always (recommended)</option>
              <option value="unless-stopped">Unless Stopped</option>
              <option value="on-failure">On Failure</option>
              <option value="no">Never</option>
            </select>
          </div>
          <div class="form-group">
            <label for="workingDir">Working Directory</label>
            <input
              type="text"
              id="workingDir"
              placeholder="/app"
              bind:value={workingDir}
            />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="memoryLimit">Memory Limit</label>
            <input
              type="text"
              id="memoryLimit"
              placeholder="e.g. 512m, 2g (leave empty for no limit)"
              bind:value={memoryLimit}
            />
          </div>
          <div class="form-group">
            <label for="cpuLimit">CPU Limit (cores)</label>
            <input
              type="text"
              id="cpuLimit"
              placeholder="e.g. 0.5, 2 (leave empty for no limit)"
              bind:value={cpuLimit}
            />
          </div>
        </div>

        <div class="form-group">
          <label for="command">Command Override</label>
          <input
            type="text"
            id="command"
            placeholder='e.g. node server.js (leave empty to use image default)'
            bind:value={command}
          />
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
      <!-- Compose / K8s manifest editor -->
      <div class="form-section">
        <h2>Manifest</h2>
        <p class="help-text">
          {#if appType === 'compose'}
            Edit your Docker Compose YAML manifest below.
          {:else}
            Edit your Kubernetes manifest YAML below.
          {/if}
        </p>
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
    {/if}

    <!-- ── Public ports (all app types) ───────────────────────── -->
    <div class="form-section">
      <h2>Public Ports</h2>
      <p class="help-text">
        Which container ports are reachable from outside. Leave blank and the first published port
        is served on <code>:443</code> — which is what almost every application wants. Name several
        and each takes the next port, on the same hostname and the same certificate.
      </p>

      <div class="form-group">
        <label for="exposedPorts">Ports, in order</label>
        <input type="text" id="exposedPorts" name="exposedPorts" placeholder="7070, 8080" />
        <p class="help-text">
          {#if appType === 'single'}
            Container ports from the <strong>Ports</strong> section above — the left-hand number, not
            the host port.
          {:else if appType === 'compose'}
            Applies to every service. A service that needs a different answer sets a
            <code>rudder.expose: "8080"</code> label of its own, which is the usual case when one
            file defines both a gateway and a UI.
          {:else}
            Applies to every container in the manifest. A <code>kubectl apply</code> carrying
            <code>rudder.dev/expose-ports</code> overwrites whatever is set here.
          {/if}
        </p>
      </div>

      <table class="port-map">
        <thead>
          <tr><th>Position</th><th>Reached at</th></tr>
        </thead>
        <tbody>
          <tr><td>first</td><td><code>https://{previewDomain ?? 'app.example.com'}</code></td></tr>
          <tr><td>second</td><td><code>https://{previewDomain ?? 'app.example.com'}:1443</code></td></tr>
          <tr><td>third</td><td><code>https://{previewDomain ?? 'app.example.com'}:2443</code></td></tr>
          <tr><td>fourth, fifth</td><td><code>:3443</code>, <code>:4443</code></td></tr>
        </tbody>
      </table>

      <p class="help-text">
        The order you write is the mapping, so adding a port later cannot silently move an existing
        one — five ports maximum, because a worker has five HTTPS entryPoints. Ports you leave out
        stay reachable from the worker and from sibling containers, but not from outside.
      </p>
      <p class="help-text">
        <strong>HTTP services only.</strong> Every port terminates TLS and speaks HTTP, so a
        database or a game server published here gets a route that cannot work.
      </p>
      <p class="help-text">
        <strong>Only <code>:443</code> is behind OIDC.</strong> The login flow is an interactive
        browser redirect and the other ports carry machine traffic — an S3 endpoint or an admin API
        cannot follow one. An extra port that needs protecting must do it itself: an API key,
        signature authentication, mTLS. CrowdSec, the security headers and the rate limit below
        apply to every port.
      </p>
    </div>

    <!-- ── Web firewall (all app types) ────────────────────────── -->
    <div class="form-section">
      <h2>Web Firewall</h2>
      <p class="help-text">
        CrowdSec inspects every request with the OWASP Core Rule Set. CRS is <em>scored</em>: a
        request collects points from many rules and is reported once the total crosses a threshold,
        so no single rule is usually "the" problem. Nothing is blocked inline — but repeated hits
        become a ban, and <strong>a ban is by source address and applies to every application on the
        worker</strong>. One user's upload can take the whole host off the air for them.
      </p>

      <div class="form-group">
        <label for="appsecDisabledRules">Disabled rules</label>
        <input
          type="text"
          id="appsecDisabledRules"
          name="appsecDisabledRules"
          placeholder="942100, 932130"
        />
        <p class="help-text">
          CRS rule numbers, CrowdSec rule names, or both. They apply to this application only,
          matched on its hostname — on every port it serves.
          {#if appType === 'k8s'}
            A <code>kubectl apply</code> carrying
            <code>rudder.dev/appsec-disable-rules</code> overwrites whatever is set here.
          {/if}
        </p>
      </div>

      <p class="help-text">
        Leave this blank to start. The rules to disable are the ones you find actually firing on
        the worker's CrowdSec tab, against traffic you recognise — not ones guessed in advance.
      </p>
      <p class="help-text">
        Applying a change restarts CrowdSec on the worker, which takes a few seconds and is picked
        up within a minute. Every rule you list stops protecting this application against everyone.
      </p>
    </div>

    <!-- ── Security & Access Control (all app types) ──────────── -->
    <div class="form-section">
      <h2>Security & Access Control</h2>
      <p class="help-text">Rate limiting and authentication are applied at the Traefik reverse proxy level, before requests reach your application.</p>

      <input type="hidden" name="rateLimitAvg" value={rateLimitAvg} />
      <input type="hidden" name="rateLimitBurst" value={rateLimitBurst} />
      <input type="hidden" name="authType" value={authType} />
      <input type="hidden" name="authConfig" value={authConfigJson} />
      <input type="hidden" name="oidcIdTokenHeader" value={oidcIdTokenHeader} />
      <input type="hidden" name="oidcAccessTokenHeader" value={oidcAccessTokenHeader} />

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
              <p class="help-text">
                The provider's <strong>issuer</strong> URL, not the discovery document — Traefik appends
                <code>/.well-known/openid-configuration</code> itself.
              </p>
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

      {#if authType === 'global'}
        <h3 class="subsection-title">Token Forwarding</h3>
        <p class="help-text">
          Every signed-in request already arrives with
          <code>X-Forwarded-User</code>, <code>X-Forwarded-Email</code>,
          <code>X-Forwarded-Preferred-Username</code> and <code>X-Forwarded-Groups</code>,
          which is enough for applications that support proxy or trusted-header login.
          Name a header below only if this application verifies the JWT itself or needs the
          access token to call an API — the tokens are a kilobyte or two on every request.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label for="oidcIdTokenHeader">ID Token Header</label>
            <input type="text" id="oidcIdTokenHeader" placeholder="e.g. X-Auth-Request-Id-Token (empty = not sent)" bind:value={oidcIdTokenHeader} />
            <p class="help-text">
              The signed JWT identifying the user. Use <code>Authorization</code> to have it sent as
              <code>Bearer &lt;token&gt;</code> — but not if this application uses that header for its own API tokens.
            </p>
          </div>
          <div class="form-group">
            <label for="oidcAccessTokenHeader">Access Token Header</label>
            <input type="text" id="oidcAccessTokenHeader" placeholder="e.g. X-Auth-Request-Access-Token (empty = not sent)" bind:value={oidcAccessTokenHeader} />
            <p class="help-text">The token for calling APIs on the user's behalf. Sent verbatim, with no scheme prefix.</p>
          </div>
        </div>
      {/if}
    </div>

    <div class="form-actions">
      <a href="/applications" class="btn-secondary btn-lg">Cancel</a>
      <button type="submit" class="btn-primary btn-lg" disabled={loading || data.noWorkersAvailable || !selectedWorker || manifestErrors.length > 0}>
        {loading ? 'Creating…' : data.noWorkersAvailable ? 'No Workers Available' : 'Create Application'}
      </button>
    </div>
  </form>
</div>

<style>
  .form-group input::placeholder,
  .form-group select::placeholder {
    color: var(--text-muted);
  }

  .help-text {
    margin-bottom: 8px;
  }

  /* Compact enough to read as part of the help text rather than as data. */
  .port-map {
    border-collapse: collapse;
    margin: 4px 0 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .port-map th {
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 16px 4px 0;
  }
  .port-map td { padding: 2px 16px 2px 0; }
  .port-map code { font-family: var(--font-mono); font-size: 11px; }

  .error-text {
    color: var(--text-secondary);
  }

  .domain-preview {
    background: var(--accent-subtle);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .domain-value {
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--accent-text);
    background: var(--bg-overlay);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
  }

  /* Key-value env rows */

  /* Port rows */

  /* Buttons */

  .worker-select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
  }
  .worker-select:focus { border-color: var(--accent); outline: none; }

  .no-worker-banner {
    background: var(--red-subtle);
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
  }

  .no-worker-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--red-text);
    margin: 0 0 4px;
  }

  .no-worker-hint {
    font-size: 12px;
    color: var(--red);
    margin: 0;
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
