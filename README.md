# Rudder

Container orchestration platform built with SvelteKit, Drizzle ORM, and SQLite. Manage containerized applications across multiple worker nodes with built-in reverse proxy, WAF, multi-team RBAC, and CI/CD integration.

## Features

### Core
- **Application deployment** -- single container, Docker Compose, and Kubernetes manifests
- **Git-based deployment** -- build from Git repo + Dockerfile directly on workers
- **Worker provisioning** -- automated SSH-based setup of Podman, Traefik, and CrowdSec
- **Container management** -- start, stop, restart, recreate, resource limits, scaling (replicas)
- **Container logs** -- searchable, filterable, downloadable log viewer with line-level highlighting
- **Container terminal** -- xterm.js WebSocket terminal for container exec and host SSH
- **Health checks** -- configurable container health checks with status display
- **Image management** -- list, pull, and remove images on workers
- **Network management** -- create, list, and delete Podman networks on workers

### Deployment & CI/CD
- **Deployment history** -- versioned deployment records with full rollback support
- **Deploy webhooks** -- per-application webhook tokens for GitHub Actions, GitLab CI, etc.
- **Application scaling** -- run multiple replicas with Traefik load balancing
- **Application stacks** -- group applications for bulk deploy/stop/restart operations
- **Config export/import** -- export application configuration as JSON, import on any instance

### Security
- **CrowdSec WAF** -- AppSec virtual patching + behavioral IP banning on all workers
- **Per-app rate limiting** -- configurable request rate limits via Traefik middleware
- **Per-app OIDC auth** -- protect applications with OAuth 2.0 / OIDC (with PKCE)
- **Security headers** -- HSTS, X-Frame-Options, CSP, Permissions-Policy on all proxied apps
- **mTLS** -- mutual TLS for Podman API and Traefik dashboard access
- **Secrets store** -- AES-256-GCM encrypted secrets, automatically injected into deployments
- **Label sanitization** -- user-provided traefik.* labels are stripped to prevent route hijacking

### Monitoring & Alerts
- **Worker metrics** -- CPU, memory, disk, network with time-series charts
- **Container metrics** -- CPU%, memory, network I/O, disk I/O per container
- **Notification channels** -- webhook, Slack, email (configurable)
- **Alert rules** -- configurable thresholds on any metric with automatic notifications
- **Availability timeline** -- 24-hour worker uptime visualization

### Administration
- **Team-based RBAC** -- admin/member roles with team-scoped resource isolation
- **Team resource quotas** -- configurable limits on CPU, memory, containers, and applications per team
- **OIDC SSO** -- Google, GitHub, Okta, Auth0, plus generic OIDC provider
- **API keys** -- team-scoped keys with expiration for programmatic access
- **kubectl-compatible API** -- manage deployments via standard Kubernetes tooling
- **Audit logging** -- full trail of all create/update/delete operations
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
# Pin secrets to survive volume replacement (auto-generated otherwise)
SESSION_SECRET=<64-char-random-string>
ENCRYPTION_KEY=<64-char-random-string>

# Session lifetime (default 7 days)
SESSION_MAX_AGE=604800

# OIDC providers
OIDC_GOOGLE_CLIENT_ID=...
OIDC_GOOGLE_CLIENT_SECRET=...
```

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

> **Secrets persistence:** `SESSION_SECRET` and `ENCRYPTION_KEY` are auto-generated and stored in the PVC (`/app/data/.secrets.json`). Uncomment the corresponding fields in `rudder-secrets` if you want to pin them explicitly (recommended when moving data between clusters).

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
| `SESSION_SECRET` | No | auto-generated | Min 32-char string for session integrity. Auto-generated and persisted in the data volume on first boot. |
| `ENCRYPTION_KEY` | No | auto-generated | Min 32-char string for secret encryption (AES-256-GCM). Auto-generated and persisted on first boot. |
| `SESSION_MAX_AGE` | No | `604800` (7 days) | Session lifetime in seconds. |
| `DATABASE_URL` | No | `file:./data/rudder.db` | SQLite database path. |
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

- All API endpoints require authentication (session or API key)
- Worker management requires admin role
- SSH private keys encrypted at rest (AES-256-GCM)
- Passwords hashed with bcrypt (12 rounds)
- Podman API secured with mutual TLS (client certificate required)
- CrowdSec AppSec WAF on all application routes with IP ban enforcement
- Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- User-provided container labels sanitized to prevent Traefik route hijacking
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
kubectl delete pod <pod-name>       # Remove container
```

### Setup

1. Generate a kubeconfig (requires active session):

```sh
# Team-scoped access
curl -X POST https://your-rudder/api/kubeconfig \
  -H "Content-Type: application/json" \
  -H "Cookie: session_id=YOUR_SESSION" \
  -d '{"teamId": "your-team-id"}'

# Global admin access
curl -X POST https://your-rudder/api/kubeconfig \
  -H "Content-Type: application/json" \
  -H "Cookie: session_id=YOUR_SESSION" \
  -d '{}'
```

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
