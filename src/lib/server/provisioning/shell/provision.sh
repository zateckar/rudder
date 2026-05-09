#!/bin/bash
# shellcheck disable=SC2050  # {{PLACEHOLDER}} markers are replaced at build time
# Worker provisioning for {{WORKER_NAME}}
# Only ports 22 (SSH) and 443 (Traefik HTTPS) are exposed externally
# Podman API is secured with mTLS (mutual TLS) - requires client certificate
# All configs are base64-encoded to avoid heredoc/quoting issues

set -o pipefail

FAILURES=0
step() {
  local name="$1"
  shift
  if "$@"; then
    echo "STEP_DONE:${name}"
  else
    echo "STEP_FAIL:${name}"
    exit 1
  fi
}

echo "=== Starting worker provisioning for {{WORKER_NAME}} ==="

if [ "$EUID" -ne 0 ]; then
    echo "ERROR: Must run as root"
    exit 1
fi

# Detect OS
if [ -f /etc/debian_version ]; then
    OS="debian"
elif [ -f /etc/redhat-release ]; then
    OS="rhel"
else
    echo "Unsupported OS"
    exit 1
fi
export OS

# ── Step functions ──────────────────────────────────────────────────────

step_podman() {
  echo "--- 1. Installing Podman, openssl, and netcat ---"
  if [ "$OS" = "debian" ]; then
    if command -v podman &> /dev/null; then
      echo "Podman already installed: $(podman --version)"
    else
      rm -f /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list 2>/dev/null
      apt-get update -q
      apt-get install -y podman curl openssl netcat-openbsd 2>&1
      if ! command -v podman &> /dev/null; then
        add-apt-repository -y universe
        apt-get update -q
        apt-get install -y podman curl openssl netcat-openbsd 2>&1
      fi
    fi
    # Ensure netcat is available
    if ! command -v nc &> /dev/null; then
      apt-get update -q
      apt-get install -y netcat-openbsd 2>&1
    fi
  elif [ "$OS" = "rhel" ]; then
    dnf -y module enable podman
    dnf -y install podman curl openssl nc
  fi
  podman --version || { echo "ERROR: Podman not installed"; exit 1; }
  command -v nc &> /dev/null && echo "netcat installed: $(nc -h 2>&1 | head -1)" || echo "WARNING: netcat not found"
}

step_registries() {
  echo "--- 2. Configuring Podman registries ---"
  mkdir -p /etc/containers
  echo "{{REGISTRIES_B64}}" | base64 -d > /etc/containers/registries.conf
  echo "Registries configured"
}

step_podman_socket() {
  echo "--- 3. Disabling default Podman socket (we use a custom service) ---"
  systemctl stop podman.socket 2>/dev/null || true
  systemctl disable podman.socket 2>/dev/null || true
  echo "Default podman.socket disabled"
}

step_cleanup_old() {
  echo "--- 4. Removing old host Traefik binary and service ---"
  systemctl stop traefik.service 2>/dev/null || true
  systemctl disable traefik.service 2>/dev/null || true
  systemctl reset-failed traefik.service 2>/dev/null || true
  pkill -f "/usr/local/bin/traefik" 2>/dev/null || true
  rm -f /usr/local/bin/traefik 2>/dev/null || true
  rm -f /etc/systemd/system/traefik.service 2>/dev/null || true
  systemctl daemon-reload || true
  sleep 2
  echo "Old host Traefik removed"

  echo "--- 5. Stopping existing containerized services ---"
  systemctl stop traefik-container.service 2>/dev/null || true
  systemctl stop crowdsec-container.service 2>/dev/null || true
  systemctl stop podman-api-http.service 2>/dev/null || true
  systemctl stop podman-api.service 2>/dev/null || true
  systemctl stop podman-api-socket.service 2>/dev/null || true
  systemctl stop podman-api-tcp.service 2>/dev/null || true
  podman stop traefik 2>/dev/null || true
  podman rm -f traefik 2>/dev/null || true
  podman stop crowdsec 2>/dev/null || true
  podman rm -f crowdsec 2>/dev/null || true
  fuser -k 8080/tcp 2>/dev/null || true
  sleep 3
  # We no longer wipe the CrowdSec DB on every provisioning to preserve decisions and state.
  # The registration script will handle updating the bouncer key if it changed.
  echo "CrowdSec state preserved"
}

step_mtls_certs() {
  echo "--- 6. Generating mTLS certificates for Podman API security ---"
  mkdir -p /etc/traefik/certs
  chmod 700 /etc/traefik/certs

  # Skip generation if CA key already exists
  if [ -f /etc/traefik/certs/ca.key ]; then
    echo "mTLS certificates already exist, skipping generation"
  else
    # Generate CA key and certificate
    openssl genrsa -out /etc/traefik/certs/ca.key 4096 2>/dev/null
    openssl req -new -x509 -key /etc/traefik/certs/ca.key \
      -out /etc/traefik/certs/ca.crt \
      -days 3650 \
      -subj "/CN=rudder-ca/O=Rudder/OU=Infrastructure" 2>/dev/null

    # Generate client certificate for Rudder control plane
    openssl genrsa -out /etc/traefik/certs/client.key 4096 2>/dev/null
    openssl req -new -key /etc/traefik/certs/client.key \
      -out /etc/traefik/certs/client.csr \
      -subj "/CN=rudder-control-plane/O=Rudder/OU=ControlPlane" 2>/dev/null
    openssl x509 -req \
      -in /etc/traefik/certs/client.csr \
      -CA /etc/traefik/certs/ca.crt \
      -CAkey /etc/traefik/certs/ca.key \
      -CAcreateserial \
      -out /etc/traefik/certs/client.crt \
      -days 365 2>/dev/null

    chmod 600 /etc/traefik/certs/*.key
    chmod 644 /etc/traefik/certs/*.crt
    echo "mTLS certificates generated"
  fi
}

step_podman_api() {
  echo "--- 7. Setting up Podman REST API (Unix socket + TCP:8080) ---"
  echo "{{PODMAN_API_SOCKET_SERVICE_B64}}" | base64 -d > /etc/systemd/system/podman-api-socket.service
  echo "{{PODMAN_API_TCP_SERVICE_B64}}" | base64 -d > /etc/systemd/system/podman-api-tcp.service
  systemctl daemon-reload
  systemctl enable podman-api-socket.service
  systemctl enable podman-api-tcp.service
  systemctl restart podman-api-socket.service
  systemctl restart podman-api-tcp.service
  sleep 5
  # Wait for both socket and TCP to be ready
  local READY=0
  for i in {1..10}; do
    if curl -sf http://127.0.0.1:8080/_ping > /dev/null 2>&1; then
      echo "Podman API TCP: OK"
      break
    fi
    if [ $i -eq 10 ]; then READY=1; fi
    echo "Waiting for Podman API TCP... ($i/10)"
    sleep 2
  done
  if [ $READY -ne 0 ]; then echo "ERROR: Podman API TCP failed to start"; exit 1; fi
  if [ -S /run/podman/podman.sock ]; then
    echo "Podman API Unix socket: OK"
  else
    echo "Warning: Podman Unix socket not found"
  fi
}

get_latest_github_tag() {
  local repo=$1
  local default=$2
  local tag=$(curl -sI "https://github.com/${repo}/releases/latest" | grep -i location | sed -E -n 's|.*tag/(.*)|\1|p' | tr -d '\r')
  if [ -z "$tag" ]; then echo "$default"; else echo "$tag"; fi
}

step_traefik_config() {
  echo "--- 8. Writing Traefik configuration ---"
  echo "Detecting latest plugin versions..."
  CROWDSEC_VERSION="latest"
  TRAEFIK_VERSION="latest"
  echo "Using CrowdSec version: ${CROWDSEC_VERSION}"
  echo "Using Traefik version: ${TRAEFIK_VERSION}"

  BOUNCER_VERSION=$(get_latest_github_tag "maxlerebourg/crowdsec-bouncer-traefik-plugin" "v1.6.0")
  OIDC_VERSION=$(get_latest_github_tag "lukaszraczylo/traefikoidc" "v1.0.7")
  echo "Using bouncer version: ${BOUNCER_VERSION}"
  echo "Using OIDC version: ${OIDC_VERSION}"

  mkdir -p /etc/traefik/dynamic /etc/traefik/acme /var/log/traefik
  echo "{{TRAEFIK_YML_B64}}" | base64 -d > /etc/traefik/traefik.yml
  echo "traefik.yml written (port 443 only, TLS-ALPN-01, CrowdSec plugin)"
  sed -i "s/BOUNCER_VERSION_PLACEHOLDER/${BOUNCER_VERSION}/g" /etc/traefik/traefik.yml
  sed -i "s/OIDC_VERSION_PLACEHOLDER/${OIDC_VERSION}/g" /etc/traefik/traefik.yml
  echo "traefik.yml updated with latest plugin versions"
  echo "{{PODMAN_API_ROUTING_B64}}" | base64 -d > /etc/traefik/dynamic/podman-api.yml
  echo "podman-api.yml (mTLS-secured Podman API route) written"

  # Metrics endpoint route — secured with same mTLS as Podman API
  if [ -n "{{METRICS_ROUTING_B64}}" ]; then
    echo "{{METRICS_ROUTING_B64}}" | base64 -d > /etc/traefik/dynamic/metrics.yml
    echo "metrics.yml (mTLS-secured host metrics route) written"
  fi

  echo "{{CROWDSEC_MIDDLEWARE_B64}}" | base64 -d > /etc/traefik/dynamic/crowdsec.yml
  echo "crowdsec.yml (CrowdSec AppSec middleware) written"

  if [ -n "{{GLOBAL_OIDC_MIDDLEWARE_B64}}" ]; then
    echo "{{GLOBAL_OIDC_MIDDLEWARE_B64}}" | base64 -d > /etc/traefik/dynamic/global-oidc.yml
    echo "global-oidc.yml (Global OIDC middleware) written"
  fi

  cat > /etc/logrotate.d/traefik << 'LOGROTATEEOF'
/var/log/traefik/access.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
    maxsize 100M
}
LOGROTATEEOF
  echo "Logrotate configured for Traefik access logs (daily, 14 days, 100M max)"

  touch /etc/traefik/acme/acme.json
  chmod 600 /etc/traefik/acme/acme.json
}

step_crowdsec() {
  echo "--- 9. Setting up CrowdSec ---"
  mkdir -p /var/lib/crowdsec/data /etc/crowdsec /etc/crowdsec/acquis.d
  chmod 755 /var/lib/crowdsec/data
  echo "{{CROWDSEC_ACQUIS_B64}}" | base64 -d > /etc/crowdsec/acquis.yaml
  echo "{{CROWDSEC_APPSEC_ACQUIS_B64}}" | base64 -d > /etc/crowdsec/acquis.d/appsec.yaml
  echo "{{CROWDSEC_CONFIG_LOCAL_B64}}" | base64 -d > /etc/crowdsec/config.yaml.local
  echo "CrowdSec config written (systemd will pull image and start container)"
}

step_traefik_ready() {
  echo "--- 10. Traefik configuration ready ---"
  echo "Traefik config written (systemd will pull image and start container)"
}

step_systemd_services() {
  echo "--- 11. Starting systemd services ---"
  echo "{{TRAEFIK_SERVICE_B64}}" | base64 -d > /etc/systemd/system/traefik-container.service
  echo "{{CROWDSEC_SERVICE_B64}}" | base64 -d > /etc/systemd/system/crowdsec-container.service
  # Replace version placeholders in systemd units (must happen after writing files)
  sed -i "s/CROWDSEC_VERSION_PLACEHOLDER/${CROWDSEC_VERSION}/g" /etc/systemd/system/crowdsec-container.service
  sed -i "s/TRAEFIK_VERSION_PLACEHOLDER/${TRAEFIK_VERSION}/g" /etc/systemd/system/traefik-container.service
  systemctl daemon-reload
  systemctl enable traefik-container.service
  systemctl enable crowdsec-container.service
  echo "Starting CrowdSec (will pull image in background)..."
  systemctl start crowdsec-container.service
  echo "Starting Traefik (will pull image in background)..."
  systemctl start traefik-container.service
  echo "Services started - images will be pulled by systemd"
}

# ── Execute steps ──────────────────────────────────────────────────────

step "podman" step_podman
step "registries" step_registries
step "podman-socket" step_podman_socket
step "cleanup-old" step_cleanup_old
step "mtls-certs" step_mtls_certs
step "podman-api" step_podman_api
step "traefik-config" step_traefik_config
step "crowdsec" step_crowdsec
step "traefik" step_traefik_ready
step "systemd-services" step_systemd_services

# ── CrowdSec bouncer key registration ──────────────────────────────────

echo "{{CROWDSEC_REGISTER_SCRIPT_B64}}" | base64 -d > /usr/local/bin/rudder-crowdsec-register.sh
chmod +x /usr/local/bin/rudder-crowdsec-register.sh

echo "{{CROWDSEC_REGISTER_SERVICE_B64}}" | base64 -d > /etc/systemd/system/rudder-crowdsec-register.service
systemctl daemon-reload
systemctl start --no-block rudder-crowdsec-register.service
echo "CrowdSec bouncer registration started in background (will restart Traefik once LAPI is ready)"

echo "=== Checking service status (images pulling in background) ==="
# Quick check for Podman API (should be ready immediately)
for i in {1..5}; do
  if curl -sf http://127.0.0.1:8080/_ping > /dev/null 2>&1; then
    echo "Podman API: READY"
    break
  fi
  echo "Waiting for Podman API... ($i/5)"
  sleep 1
done

# Quick check for metrics HTTP endpoint
for i in {1..3}; do
  if curl -sf http://127.0.0.1:9100/ | grep -q cpu_percent; then
    echo "Metrics HTTP: READY"
    break
  fi
  echo "Waiting for metrics HTTP endpoint... ($i/3)"
  sleep 1
done

echo "Note: Traefik and CrowdSec are pulling images in background via systemd"
echo "Port 443 will be available once image pulls complete (check with: systemctl status traefik-container)"

# ── Netavark stale-rule cleanup ────────────────────────────────────────

echo "{{NETAVARK_CLEANUP_SCRIPT_B64}}" | base64 -d > /usr/local/bin/rudder-netavark-cleanup.sh
chmod +x /usr/local/bin/rudder-netavark-cleanup.sh

echo "{{NETAVARK_CLEANUP_SERVICE_B64}}" | base64 -d > /etc/systemd/system/rudder-netavark-cleanup.service
echo "{{NETAVARK_CLEANUP_TIMER_B64}}" | base64 -d > /etc/systemd/system/rudder-netavark-cleanup.timer
systemctl daemon-reload
systemctl enable --now rudder-netavark-cleanup.timer
echo "Netavark cleanup timer installed (runs every 5 min)"

# ── Host metrics HTTP endpoint ─────────────────────────────────────────

echo "{{METRICS_SCRIPT_B64}}" | base64 -d > /usr/local/bin/rudder-metrics.sh
chmod +x /usr/local/bin/rudder-metrics.sh

echo "{{METRICS_HTTP_SCRIPT_B64}}" | base64 -d > /usr/local/bin/rudder-metrics-http.sh
chmod +x /usr/local/bin/rudder-metrics-http.sh

echo "{{METRICS_SERVICE_B64}}" | base64 -d > /etc/systemd/system/rudder-metrics.service
echo "{{METRICS_TIMER_B64}}" | base64 -d > /etc/systemd/system/rudder-metrics.timer
echo "{{METRICS_HTTP_SERVICE_B64}}" | base64 -d > /etc/systemd/system/rudder-metrics-http.service

systemctl daemon-reload
systemctl enable rudder-metrics.timer
systemctl enable rudder-metrics-http.service

# Run initial metrics collection
/usr/local/bin/rudder-metrics.sh

# Start metrics services
systemctl start rudder-metrics.timer
systemctl start rudder-metrics-http.service

echo "Host metrics HTTP service installed (shell-only, port 9100, collected every 30s)"

# ── Final status ───────────────────────────────────────────────────────

WORKER_IP=$(hostname -I | awk '{print $1}')
echo "=== Provisioning complete for {{WORKER_NAME}} ==="
echo "Worker IP: ${WORKER_IP}"
echo "Exposed: 22 (SSH), 443 (Traefik HTTPS)"
echo "Internal: 8080 (Podman API, localhost only)"
echo "Security: Podman API secured with mTLS client certificate authentication"
echo "WAF: CrowdSec AppSec enabled on all applications via Traefik plugin"
if [ -n "{{BASE_DOMAIN}}" ]; then
  echo "Podman API URL: https://podman-api.{{BASE_DOMAIN}}"
  echo "Traefik dashboard: https://traefik.{{BASE_DOMAIN}}/dashboard/"
  echo ""
  echo "NOTE: Let's Encrypt TLS certificates may take 30-60 seconds to obtain on first provision."
  echo "      HTTPS endpoints will return errors until certificates are ready."
else
  echo "Podman API URL: https://${WORKER_IP}"
fi

echo "=== Provisioning status ==="
systemctl is-active podman-api-socket.service && echo "Podman API Unix socket service: ACTIVE" || echo "Podman API Unix socket service: starting"
systemctl is-active podman-api-tcp.service && echo "Podman API TCP service: ACTIVE" || echo "Podman API TCP service: starting"
systemctl is-active traefik-container.service && echo "Traefik service: ACTIVE" || echo "Traefik service: starting (pulling image)"
systemctl is-active crowdsec-container.service && echo "CrowdSec service: ACTIVE" || echo "CrowdSec service: starting (pulling image)"
systemctl is-active rudder-metrics-http.service && echo "Metrics HTTP service: ACTIVE" || echo "Metrics HTTP service: starting"
curl -sf http://127.0.0.1:8080/_ping > /dev/null 2>&1 && echo "Podman API TCP: ONLINE" || echo "Podman API TCP: not ready"
[ -S /run/podman/podman.sock ] && echo "Podman API Unix socket: EXISTS" || echo "Podman API Unix socket: not ready"
curl -sf http://127.0.0.1:9100/ | grep -q cpu_percent && echo "Metrics HTTP: ONLINE" || echo "Metrics HTTP: not ready"
if podman ps --filter name=traefik --format "{{.Status}}" | grep -q .; then
  podman ps --filter name=traefik --format "Traefik container: {{.Status}}"
else
  systemctl is-failed traefik-container.service >/dev/null && echo "Traefik container: FAILED (check logs)" || echo "Traefik container: starting/pulling"
fi

if podman ps --filter name=crowdsec --format "{{.Status}}" | grep -q .; then
  podman ps --filter name=crowdsec --format "CrowdSec container: {{.Status}}"
else
  systemctl is-failed crowdsec-container.service >/dev/null && echo "CrowdSec container: FAILED (check logs)" || echo "CrowdSec container: starting/pulling"
fi

echo ""
if [ $FAILURES -gt 0 ]; then
  echo "WARNING: $FAILURES step(s) had errors"
fi

echo ""
echo "=== CERTS_BEGIN ==="
echo "CA_CERT_B64=$(cat /etc/traefik/certs/ca.crt | base64 -w 0)"
echo "CLIENT_CERT_B64=$(cat /etc/traefik/certs/client.crt | base64 -w 0)"
echo "CLIENT_KEY_B64=$(cat /etc/traefik/certs/client.key | base64 -w 0)"
echo "BOUNCER_KEY={{BOUNCER_KEY}}"
echo "=== CERTS_END ==="
