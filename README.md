# Rudder

Container orchestration platform built with SvelteKit, Drizzle ORM, and SQLite. Manage containerized applications across multiple worker nodes with built-in reverse proxy, WAF, multi-team RBAC, and CI/CD integration.

## Features

### Core
- **Application deployment** -- single container, Docker Compose, and Kubernetes manifests
- **Worker provisioning** -- automated SSH-based setup of Podman, Traefik, CrowdSec, and an nftables host firewall
- **Container management** -- start, stop, restart, recreate, resource limits, scaling (replicas)
- **Container logs** -- searchable, filterable, downloadable log viewer with line-level highlighting
- **Container terminal** -- xterm.js WebSocket terminal for container exec and host SSH
- **Health checks** -- configurable container health checks with status display
- **Image management** -- list, pull, and remove images on workers
- **Network management** -- create, list, and delete Podman networks on workers

### Deployment & CI/CD
- **Deployment history** -- versioned deployment records with full rollback support
- **Digest-pinned rollback** -- each deployment records the image digest it actually ran, and rollback recreates containers from that digest rather than re-resolving the tag
- **Deploy webhooks** -- per-application webhook tokens for GitHub Actions, GitLab CI, etc.
- **Application scaling** -- run multiple replicas with Traefik load balancing
- **Application stacks** -- group applications for bulk deploy/stop/restart operations
- **Config export/import** -- export application configuration as JSON, import on any instance

### Security
- **CrowdSec WAF** -- AppSec virtual patching inline, OWASP Core Rule Set out-of-band, plus behavioral IP banning on all workers
- **No WAF bypass** -- application ports bind to 127.0.0.1 and an nftables ruleset limits inbound traffic to SSH and 443, so requests cannot reach an app without passing Traefik
- **Per-app rate limiting** -- configurable request rate limits via Traefik middleware
- **Worker-wide OIDC** -- one identity-provider registration protects every app on a worker, via a shared `auth.<base-domain>/oidc/callback` endpoint (requires a DNS A record for that host)
- **Per-app OIDC auth** -- protect individual applications with their own OAuth 2.0 / OIDC client (with PKCE)
- **Security headers** -- HSTS, X-Frame-Options, CSP, Permissions-Policy on all proxied apps
- **mTLS** -- mutual TLS for Podman API and Traefik dashboard access (required; no plaintext fallback)
- **Secrets store** -- AES-256-GCM encrypted secrets, automatically injected into deployments
- **File-mode secrets** -- deliver a secret as `/run/secrets/<NAME>` on a tmpfs at mode 0400 instead of an environment variable, keeping it out of `podman inspect` and the process environment
- **Host patching** -- provisioning installs pending security updates and configures unattended-upgrades, including the `-updates` pocket that podman needs
- **Pinned platform images** -- Traefik and CrowdSec run a version pinned in this repo and resolved to a digest, so no re-provision can upgrade them by accident
- **Label sanitization** -- user-provided traefik.* labels are stripped to prevent route hijacking
- **Mount policy** -- host bind mounts are denied unless explicitly allow-listed by an operator
- **Login throttling** -- per-user and per-IP rate limiting with failed attempts audited

### Monitoring & Alerts
- **Worker metrics** -- CPU, memory, disk, network with time-series charts
- **Container metrics** -- CPU%, memory, network I/O, disk I/O per container
- **Per-application HTTP telemetry** -- Traefik's Prometheus metrics, labelled by router and service, scrapeable at `https://metrics.<base-domain>/prometheus/metrics` behind the same mTLS as the Podman API
- **Patch state** -- pending updates, pending *security* updates and `reboot-required` reported per worker and usable as alert thresholds
- **Notification channels** -- webhook, Slack, email (configurable)
- **Alert rules** -- configurable thresholds on any metric with automatic notifications
- **Availability timeline** -- 24-hour worker uptime visualization

### Administration
- **Team-based RBAC** -- admin/member roles with team-scoped resource isolation
- **Team resource quotas** -- configurable limits on CPU, memory, containers, and applications per team
- **OIDC SSO** -- Google, GitHub, Okta, Auth0, plus generic OIDC provider
- **API keys** -- team-scoped keys (team owners) or global keys (admins), with optional expiry
- **kubectl-compatible API** -- manage deployments via standard Kubernetes tooling
- **Audit logging** -- every mutating request, by session user or API key, plus failed logins
- **Azure backup/restore** -- automated daily backup to Azure Blob Storage with restore

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.0+

### Local development

```sh
bun install
bun run dev
```

On first start the app creates the database, runs all migrations, and bootstraps a default admin account:

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `admin` |

Open <http://localhost:5173> and log in.

> **Tip:** set `ADMIN_PASSWORD=yourpassword` in a `.env` file before the first start to use a custom password instead of the default.

---

## Deployment

Rudder is designed to run **always behind an HTTPS reverse proxy** (nginx, Caddy, Traefik, …). The Docker image has `X-Forwarded-Proto` / `X-Forwarded-Host` support baked in — no extra configuration needed for TLS termination.

The database schema, secrets, and admin user are all initialised automatically on first boot.

Start the built app with `bun run server.js`, not `build/index.js`. Both serve
the same application, but the adapter's own entry point cannot handle WebSocket
upgrades, so the container terminal and `kubectl exec` would connect and then
hang. `server.js` is the adapter handler plus one `upgrade` listener. Whatever
proxy sits in front must forward upgrades too (`proxy_set_header Upgrade` /
`Connection` for nginx; Traefik and Caddy do it by default).

### Docker Compose

**1. Create a `.env` file:**

```env
ADMIN_PASSWORD=yourpassword
PUBLIC_URL=https://your-domain.example.com
```

**2. Start:**

```sh
docker compose up -d
```

That's it. The app is running and the admin account is ready.

**Optional `.env` settings:**

```env
# Pin the encryption key to survive volume replacement (auto-generated otherwise).
# Losing it makes every stored secret permanently unreadable.
ENCRYPTION_KEY=<64-char-random-string>

# Session lifetime (default 7 days)
SESSION_MAX_AGE=604800

# Host directories applications may bind-mount (comma-separated).
# Empty (the default) disables host path mounts; named volumes still work.
ALLOWED_HOST_MOUNT_PREFIXES=/srv/appdata

# OIDC providers
OIDC_GOOGLE_CLIENT_ID=...
OIDC_GOOGLE_CLIENT_SECRET=...
```

> **Behind a proxy:** set `ORIGIN` to the browser-facing URL (e.g.
> `https://rudder.example.com`). SvelteKit compares it against the request origin
> for CSRF protection. The image does **not** trust `X-Forwarded-Host`, because
> doing so would let a client choose its own origin unless the proxy always
> overwrites that header.

### Kubernetes

**1. Copy and edit the manifest:**

```sh
cp k8s/deployment.yaml my-deployment.yaml
```

At minimum, update:
- `ADMIN_PASSWORD` in the `rudder-secrets` Secret
- `PUBLIC_URL` in the `rudder-config` ConfigMap
- The `host:` field in the Ingress rule

**2. Apply:**

```sh
kubectl apply -f my-deployment.yaml
```

The app initialises itself on first boot — no init jobs or manual steps required.

> **Secrets persistence:** `ENCRYPTION_KEY` is auto-generated and stored in the PVC (`/app/data/.secrets.json`). Pin it explicitly in `rudder-secrets` when moving data between clusters — without the original key, stored secrets cannot be decrypted. If the data directory is not writable, the app refuses to start in production rather than generating a key that would be lost on restart.

### CI/CD

The GitHub Actions workflow (`.github/workflows/docker-publish.yml`) automatically:
- Runs type checks on PRs
- Builds and pushes Docker images to GHCR on merge to `main` or version tags

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_PASSWORD` | **Yes** (production) | `admin` (dev only) | Password for the auto-created `admin` account. Set before first boot; ignored once the user exists. |
| `PUBLIC_URL` | **Yes** | `http://localhost:5173` | External URL of the app — used in OIDC redirects and links. |
| `ORIGIN` | **Yes** (behind a proxy) | — | Browser-facing URL, used for CSRF origin checks. |
| `ENCRYPTION_KEY` | No | auto-generated | Min 32-char string for secret encryption (AES-256-GCM). Auto-generated and persisted on first boot. A shorter value is rejected at startup. |
| `SESSION_MAX_AGE` | No | `604800` (7 days) | Session lifetime in seconds. |
| `DATABASE_URL` | No | `./data/rudder.db` | SQLite database path. Accepts a bare path or `file:` URL; generated secrets and `known_hosts` are stored alongside it. |
| `ALLOWED_HOST_MOUNT_PREFIXES` | No | — | Comma-separated host directories applications may bind-mount. Empty disables host mounts. `/proc`, `/etc`, `/dev`, `/usr` and similar are always denied. |
| `ALLOW_INSECURE_PODMAN` | No | `false` | Permit talking to a worker's Podman API without mTLS. Development only. |
| `WORKER_REGISTRATION_SECRET` | No | — | Shared secret for worker self-registration. |
| `OIDC_GOOGLE_CLIENT_ID` | No | — | Google OAuth client ID. |
| `OIDC_GOOGLE_CLIENT_SECRET` | No | — | Google OAuth client secret. |
| `OIDC_GITHUB_CLIENT_ID` | No | — | GitHub OAuth client ID. |
| `OIDC_GITHUB_CLIENT_SECRET` | No | — | GitHub OAuth client secret. |
| `OIDC_OKTA_CLIENT_ID` | No | — | Okta OIDC client ID. |
| `OIDC_OKTA_CLIENT_SECRET` | No | — | Okta OIDC client secret. |
| `OIDC_OKTA_DOMAIN` | No | — | Okta domain (e.g. `company.okta.com`). |
| `OIDC_AUTH0_CLIENT_ID` | No | — | Auth0 client ID. |
| `OIDC_AUTH0_CLIENT_SECRET` | No | — | Auth0 client secret. |
| `OIDC_AUTH0_DOMAIN` | No | — | Auth0 domain (e.g. `company.auth0.com`). |

---

## Architecture

```
Browser (Svelte 5 + xterm.js + Monaco Editor)
    |
    v
SvelteKit Server (Bun runtime with Node adapter)
    |-- Security headers, session auth, audit logging
    |-- REST API + WebSocket (terminal)
    |-- K8s-compatible API (/k8s/) for kubectl access
    |
    +-- SQLite (Drizzle ORM, WAL mode)
    |
    +-- Worker Nodes (via SSH + Podman REST API)
        |-- Traefik (reverse proxy, Let's Encrypt, CrowdSec plugin, OIDC plugin)
        |-- CrowdSec (WAF + IPS, behavioral banning)
        |-- Podman containers (user applications)
```

---

## Security

- All API endpoints require authentication (session or API key) **and** authorization:
  applications, containers and terminals are scoped to the caller's teams; workers,
  users and system settings are admin-only
- SSH private keys are never stored server-side — they live in an encrypted
  browser-side vault and are supplied per operation
- Stored worker credentials (Podman mTLS client key, CrowdSec bouncer key, worker
  OIDC secrets) and all user secrets are encrypted at rest (AES-256-GCM)
- Session tokens are 256-bit and stored hashed; database read access does not
  yield usable sessions
- Passwords hashed with bcrypt (12 rounds); logins are rate limited per user and
  per source address
- Podman API secured with mutual TLS (client certificate required; connections
  fail closed if credentials are missing)
- Host bind mounts are denied by default and must be explicitly allow-listed
- The nftables ruleset filters traffic from the container bridges as well as from
  outside, so a container cannot reach the Podman API, the CrowdSec LAPI or the
  metrics endpoint on the host gateway (nor via `host.containers.internal`). The
  one exception is UDP/TCP port 53 on the podman bridges, which is where
  `aardvark-dns` serves container name resolution
- CrowdSec AppSec WAF on all application routes with IP ban enforcement.
  Virtual-patching rules block known exploit signatures inline (403); the OWASP
  Core Rule Set runs out-of-band, scoring SQLi/XSS/LFI/RCE attempts and banning
  the source once the anomaly threshold is crossed. Out-of-band is deliberate —
  CRS false positives cost a visible, removable ban decision rather than a
  broken request. To block inline instead, add `crowdsecurity/appsec-crs-inband`
  to the CrowdSec container's `COLLECTIONS` and reference `crowdsecurity/crs-inband`
  in `/etc/crowdsec/acquis.d/appsec.yaml`
- Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- User-provided container labels sanitized to prevent Traefik route hijacking
- Secrets can be delivered as files on a tmpfs (`/run/secrets/<NAME>`, mode 0400)
  instead of environment variables, which keeps them out of `podman inspect` and
  out of the environment of every process in the container. Set per secret;
  `env` remains the default because changing delivery under a running
  application breaks it
- Credentials are redacted from what Rudder stores and logs: an application's
  OIDC client secret is stamped into container labels for Traefik but kept out
  of `containers.labels` in the database, and the provisioning transcript is
  masked before logging (it echoes the worker's mTLS client key and CrowdSec
  bouncer key on stdout, which is how they reach the database)
- Re-provisioning a worker installs pending security updates and writes
  Rudder's own unattended-upgrades policy, adding the `${distro}-updates` pocket
  — without it podman, which lives in `universe`, is never upgraded at all.
  Rudder never reboots a worker: it reports `reboot_required` instead, so the
  reboot is scheduled by someone who knows what is running there
- Traefik and CrowdSec images are pinned to a version in this repository and
  resolved to a digest at provisioning time, so a re-provision run for an
  unrelated reason cannot move Traefik to a new major version
- Access logs rotated daily (logrotate, 14-day retention)
- Traefik dashboard protected with mTLS (same as Podman API)

---

## kubectl Integration

Rudder exposes a Kubernetes-compatible API at `/k8s/` that lets you manage deployments with standard `kubectl` commands.

### Supported Commands

```sh
kubectl get namespaces              # List teams
kubectl get deployments -n <team>   # List applications
kubectl get pods -n <team>          # List containers
kubectl describe deployment <name>  # Application details
kubectl apply -f deployment.yaml    # Create or update + deploy
kubectl scale deploy <name> --replicas=3  # Scale replicas
kubectl delete deployment <name>    # Undeploy + remove
kubectl logs <pod-name>             # Container logs
kubectl logs -f <pod-name>          # Follow (streamed)
kubectl exec <pod-name> -- <cmd>    # Run a command in a container
kubectl get events -n <team>        # Deploy history as events
kubectl delete pod <pod-name>       # Remove container
```

`kubectl exec` runs over WebSocket (`v4`/`v5.channel.k8s.io`), so it needs
kubectl 1.29 or newer — older clients negotiate SPDY, which is not supported.

**Interactive sessions (`-i` / `-it`) are not available.** Rudder reaches a
worker's Podman API through that worker's Traefik for mTLS, and Traefik does not
proxy the non-WebSocket connection upgrade that attaching stdin requires; the
request is answered with a 500. Commands run and their output and exit code come
back normally — only stdin is missing, and asking for it returns an error
saying so rather than silently discarding your input. The same constraint
applies to the container terminal in the UI.

### Setup

1. Generate a kubeconfig. This mints an API key, so it needs an active session
   and the same privileges as creating one by hand: **team owner** for a
   team-scoped config, **admin** for a global one.

```sh
# Team-scoped access (team owners and admins)
curl -X POST https://your-rudder/api/kubeconfig \
  -H "Content-Type: application/json" \
  -H "Cookie: session_id=YOUR_SESSION" \
  -d '{"teamId": "your-team-id"}'

# Global access across every team (admins only)
curl -X POST https://your-rudder/api/kubeconfig \
  -H "Content-Type: application/json" \
  -H "Cookie: session_id=YOUR_SESSION" \
  -d '{}'
```

The returned token is shown once and cannot be retrieved again. Revoke it from
**Settings → API keys** if it leaks.

2. Save the returned `kubeconfig` field to `~/.kube/config` (or use `KUBECONFIG` env var).

3. Use kubectl normally:

```sh
kubectl get deployments
kubectl get pods
```

### Resource Mapping

| Kubernetes | Rudder | Notes |
|------------|--------|-------|
| Namespace | Team | Identified by team slug |
| Deployment | Application | Supports create, update, scale, delete |
| Pod | Container | Individual running containers |
| Scale | Replicas | `kubectl scale` adjusts replica count |

### Deployment YAML Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  annotations:
    rudder.dev/worker: "worker-name"      # optional: target worker
    rudder.dev/domain: "app.example.com"   # optional: custom domain
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
        env:
        - name: NODE_ENV
          value: production
        ports:
        - containerPort: 80
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Frontend | Svelte 5, xterm.js, Monaco Editor |
| Backend | SvelteKit (Node adapter) |
| Database | SQLite (bun:sqlite, WAL mode) |
| ORM | Drizzle ORM |
| Container runtime | Podman |
| Reverse proxy | Traefik |
| WAF/IPS | CrowdSec |
| Auth | bcrypt, OIDC, API keys |
| Encryption | AES-256-GCM |
