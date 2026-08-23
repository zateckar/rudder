#!/bin/bash
# shellcheck disable=SC2050  # {{PLACEHOLDER}} markers are replaced at build time
# Worker provisioning for {{WORKER_NAME}}
# Only ports 22 (SSH) and 443 (Traefik HTTPS) are exposed externally
# Podman API is secured with mTLS (mutual TLS) - requires client certificate
# All configs are base64-encoded to avoid heredoc/quoting issues

set -o pipefail

FAILURES=0
SKIPPED=""

# A step the worker cannot function without. Aborts provisioning.
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

# A step that degrades the worker but does not break it — the firewall and the
# metrics endpoint. These used to swallow their own failures and return 0, so a
# worker could come up with no firewall at all and report success.
soft_step() {
  local name="$1"
  shift
  if "$@"; then
    echo "STEP_DONE:${name}"
  else
    FAILURES=$((FAILURES + 1))
    SKIPPED="${SKIPPED}${name} "
    echo "STEP_SKIP:${name}"
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

step_updates() {
  echo "--- 0. Host package updates ---"
  if [ "$OS" != "debian" ]; then
    echo "Automated patching is only wired up for Debian/Ubuntu; skipping on ${OS}"
    return 0
  fi

  export DEBIAN_FRONTEND=noninteractive

  # Rudder's own policy, sorted after the distro's 50unattended-upgrades so
  # these values win. Chiefly: add the -updates pocket, which is what brings
  # podman (universe) into scope at all.
  echo "{{UNATTENDED_UPGRADES_B64}}" | base64 -d > /etc/apt/apt.conf.d/51rudder-unattended
  chmod 644 /etc/apt/apt.conf.d/51rudder-unattended
  echo "Wrote /etc/apt/apt.conf.d/51rudder-unattended"

  apt-get update -q 2>&1 | tail -1 || echo "WARNING: apt-get update failed; working from cached lists"

  if ! command -v unattended-upgrade > /dev/null 2>&1; then
    apt-get install -y unattended-upgrades 2>&1 | tail -2 \
      || echo "WARNING: could not install unattended-upgrades"
  fi
  systemctl enable --now unattended-upgrades.service > /dev/null 2>&1 \
    || echo "WARNING: unattended-upgrades.service could not be enabled"
  if systemctl is-enabled unattended-upgrades.service > /dev/null 2>&1; then
    echo "unattended-upgrades: enabled"
  else
    echo "WARNING: unattended-upgrades is NOT enabled — this host will not patch itself"
  fi

  local before
  before=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)
  echo "Pending package updates: ${before:-0}"

  if [ "{{APPLY_UPDATES}}" != "1" ]; then
    echo "Update installation is disabled for this run — reporting only"
    return 0
  fi

  if [ "${before:-0}" -eq 0 ] 2>/dev/null; then
    echo "Nothing to install"
  else
    # unattended-upgrade rather than a blanket `apt-get upgrade`: the set that
    # moves is the security set from the origins above, not every held-back
    # feature update on the host.
    #
    # --force-confold is passed here rather than written into apt.conf.d
    # because that key is global — it would silently answer conffile prompts
    # for an administrator's own interactive apt run too. Without it a package
    # with a modified config file turns this into a dpkg question that nothing
    # will ever answer, and provisioning hangs.
    echo "Installing pending updates..."
    if unattended-upgrade -v \
         -o 'Dpkg::Options::=--force-confold' \
         -o 'Dpkg::Options::=--force-confdef' 2>&1 | tail -20; then
      echo "Updates applied"
    else
      echo "WARNING: unattended-upgrade exited non-zero; see the output above"
    fi

    local after
    after=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)
    echo "Pending package updates after this run: ${after:-0}"
  fi

  if [ -f /var/run/reboot-required ]; then
    echo "NOTE: this worker needs a reboot to finish applying updates."
    echo "NOTE: Rudder does not reboot workers — applications are running here."
    sed 's/^/  /' /var/run/reboot-required 2>/dev/null || true
  fi
}

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
  systemctl reset-failed traefik-container.service 2>/dev/null || true
  systemctl stop crowdsec-container.service 2>/dev/null || true
  systemctl reset-failed crowdsec-container.service 2>/dev/null || true
  systemctl stop rudder-crowdsec-register.service 2>/dev/null || true
  systemctl reset-failed rudder-crowdsec-register.service 2>/dev/null || true
  systemctl stop podman-api-http.service 2>/dev/null || true
  systemctl stop podman-api.service 2>/dev/null || true
  systemctl stop podman-api-socket.service 2>/dev/null || true
  systemctl stop podman-api-tcp.service 2>/dev/null || true
  podman stop traefik 2>/dev/null || true
  podman rm -f traefik 2>/dev/null || true
  podman stop crowdsec 2>/dev/null || true
  podman rm -f crowdsec 2>/dev/null || true
  fuser -k 8080/tcp 2>/dev/null || true
  fuser -k 8081/tcp 2>/dev/null || true
  fuser -k 7422/tcp 2>/dev/null || true
  sleep 3
  # We no longer wipe the CrowdSec DB on every provisioning to preserve decisions and state.
  # The registration script will handle updating the bouncer key if it changed.
  echo "CrowdSec state preserved"
}

step_firewall() {
  echo "--- 5b. Restricting inbound traffic to SSH and HTTPS ---"
  # Applications publish their ports on 127.0.0.1 only, but a host firewall is
  # what actually makes the documented "only 22 and 443 are exposed" true —
  # without it a single mis-set bind address re-exposes every app straight to
  # the internet, bypassing Traefik, CrowdSec and OIDC.
  #
  # Deliberately conservative: established traffic, loopback and ICMP are
  # accepted before the policy flips to drop, and both port 22 and the port
  # Rudder actually connects on are allowed, so this cannot lock us out.
  #
  # The input hook is traversed by traffic from the container bridges too, not
  # just by traffic from outside. That is the point — a container could
  # otherwise reach the Podman API on the bridge gateway and take over the
  # worker — but it also catches one path applications genuinely need: every
  # Rudder deployment runs on a user-defined podman network, whose DNS server
  # (aardvark-dns) listens on the bridge gateway. Dropping port 53 there breaks
  # name resolution for every container, so it is accepted back, scoped to the
  # podman bridge interfaces and to port 53 alone. Everything else a container
  # might aim at the host — including host.containers.internal — stays blocked.
  local SSH_PORT="{{SSH_PORT}}"
  [ -z "$SSH_PORT" ] && SSH_PORT=22

  if ! command -v nft &> /dev/null; then
    if [ "$OS" = "debian" ]; then
      apt-get install -y nftables 2>&1 || true
    elif [ "$OS" = "rhel" ]; then
      dnf -y install nftables 2>&1 || true
    fi
  fi

  if ! command -v nft &> /dev/null; then
    echo "WARNING: nftables unavailable — host firewall NOT configured."
    echo "WARNING: container ports bound to 127.0.0.1 are still protected, but"
    echo "WARNING: nothing enforces the 22/443-only policy. Configure your cloud"
    echo "WARNING: network security group instead."
    return 1
  fi

  # nftables rejects duplicate elements in an anonymous set, so only add the
  # configured port when it is not already 443 or the default 22.
  local SSH_PORTS="22, 443"
  if [ "$SSH_PORT" != "22" ] && [ "$SSH_PORT" != "443" ]; then
    SSH_PORTS="22, ${SSH_PORT}, 443"
  fi

  # Our own table, so podman/netavark's rules are never touched. The
  # create-then-delete prelude makes re-applying idempotent: without it a second
  # `nft -f` would append a duplicate set of rules to the existing table.
  #
  # The base policy stays `accept` with an explicit `drop` at the end, so a
  # half-loaded ruleset fails open rather than locking the host out.
  mkdir -p /etc/nftables.d
  cat > /etc/nftables.d/rudder.nft <<NFTEOF
#!/usr/sbin/nft -f
table inet rudder {}
delete table inet rudder

table inet rudder {
  chain input {
    type filter hook input priority 0; policy accept;
    ct state established,related accept
    ct state invalid drop
    iif lo accept
    meta l4proto { icmp, ipv6-icmp } accept
    iifname "podman*" meta l4proto { tcp, udp } th dport 53 accept
    iifname "cni-podman*" meta l4proto { tcp, udp } th dport 53 accept
    tcp dport { ${SSH_PORTS} } accept
    counter drop
  }
}
NFTEOF

  if ! nft -f /etc/nftables.d/rudder.nft; then
    echo "WARNING: failed to install nftables rules — leaving host unfiltered"
    nft delete table inet rudder 2>/dev/null || true
    rm -f /etc/nftables.d/rudder.nft
    return 1
  fi

  # Re-apply on boot. A dedicated unit avoids fighting the distro's own
  # nftables.service ruleset.
  cat > /etc/systemd/system/rudder-firewall.service << 'FWEOF'
[Unit]
Description=Rudder host firewall (SSH + HTTPS only)
After=network-pre.target
Before=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables.d/rudder.nft
ExecStop=-/usr/sbin/nft delete table inet rudder

[Install]
WantedBy=multi-user.target
FWEOF
  systemctl daemon-reload
  # `--now` as well as enable: the rules are already applied above, but without
  # starting the unit `systemctl is-active rudder-firewall` reports inactive on
  # a worker whose firewall is up, which is exactly backwards for anyone
  # checking. Re-running ExecStart is harmless — rudder.nft is idempotent.
  systemctl enable --now rudder-firewall.service 2>/dev/null || true
  echo "Host firewall active: inbound limited to ${SSH_PORTS} (SSH/HTTPS)"
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

# Resolve the latest release tag of a GitHub repository, falling back to the
# version already pinned in this worker's traefik.yml.
#
# This used to fall back to a hardcoded default, which meant an unreachable
# GitHub silently *downgraded* the bouncer or the OIDC plugin on a worker that
# was running something newer — a security control quietly moving backwards
# with nothing in the log to say so. Keeping what is installed is a no-change;
# it is announced, and only a worker with no pinned version at all fails.
get_latest_github_tag() {
  local repo=$1
  local pin_pattern=$2
  local tag
  tag=$(curl -sI --max-time 20 "https://github.com/${repo}/releases/latest" \
        | grep -i location | sed -E -n 's|.*tag/(.*)|\1|p' | tr -d '\r')
  if [ -n "$tag" ]; then
    echo "$tag"
    return 0
  fi

  local installed=""
  if [ -f /etc/traefik/traefik.yml ]; then
    installed=$(grep -A2 "${pin_pattern}" /etc/traefik/traefik.yml \
                | sed -E -n 's/^[[:space:]]*version:[[:space:]]*(.+)$/\1/p' | head -1)
  fi
  if [ -n "$installed" ] && [ "$installed" != "BOUNCER_VERSION_PLACEHOLDER" ] \
     && [ "$installed" != "OIDC_VERSION_PLACEHOLDER" ]; then
    echo "WARNING: could not reach GitHub for ${repo}; keeping the installed version ${installed}" >&2
    echo "$installed"
    return 0
  fi

  echo "ERROR: could not determine a version for ${repo} and none is installed." >&2
  echo "ERROR: Traefik will not start without its plugins — refusing to continue." >&2
  return 1
}

# Platform image versions, pinned in src/lib/server/provisioning/index.ts.
#
# Deliberately explicit, never `latest`. `podman pull` runs unconditionally on
# every provisioning run, so with a floating tag an unrelated re-provision —
# one triggered to change a rate limit, say — silently moves Traefik to
# whatever was released since, mid-maintenance, with no decision made. Pinned,
# upgrading is a diff and a commit.
CROWDSEC_VERSION="{{CROWDSEC_IMAGE_VERSION}}"
TRAEFIK_VERSION="{{TRAEFIK_IMAGE_VERSION}}"

# Resolve a tag to the digest actually pulled, so the systemd unit runs the
# bytes this provisioning run verified rather than whatever the tag points at
# by the time the unit next starts.
resolve_image_digest() {
  local ref=$1
  podman image inspect "$ref" --format '{{index .RepoDigests 0}}' 2>/dev/null | head -1
}

step_traefik_config() {
  echo "--- 8. Writing Traefik configuration ---"
  echo "Using CrowdSec version: ${CROWDSEC_VERSION}"
  echo "Using Traefik version: ${TRAEFIK_VERSION}"

  echo "Detecting latest plugin versions..."
  BOUNCER_VERSION=$(get_latest_github_tag "maxlerebourg/crowdsec-bouncer-traefik-plugin" "crowdsec-bouncer-traefik-plugin") || return 1
  OIDC_VERSION=$(get_latest_github_tag "sevensolutions/traefik-oidc-auth" "sevensolutions/traefik-oidc-auth") || return 1
  echo "Using bouncer version: ${BOUNCER_VERSION}"
  echo "Using OIDC version: ${OIDC_VERSION}"

  mkdir -p /etc/traefik/dynamic /etc/traefik/acme /var/log/traefik
  echo "{{TRAEFIK_YML_B64}}" | base64 -d > /etc/traefik/traefik.yml
  echo "traefik.yml written (port 443 only, TLS-ALPN-01, CrowdSec plugin)"
  sed -i "s/BOUNCER_VERSION_PLACEHOLDER/${BOUNCER_VERSION}/g" /etc/traefik/traefik.yml
  sed -i "s/OIDC_VERSION_PLACEHOLDER/${OIDC_VERSION}/g" /etc/traefik/traefik.yml
  echo "traefik.yml updated with latest plugin versions"
  # Only written when there is a base domain to bind the router to. Traefik ties
  # tls.options (and so RequireAndVerifyClientCert) to a router's SNI, so there
  # is no way to require a client certificate on a catch-all route — the
  # host-less variant this replaces published the Podman API unauthenticated on
  # 443. Removed rather than left stale: a route file from an earlier run would
  # outlive the config that stopped generating it.
  if [ -n "{{PODMAN_API_ROUTING_B64}}" ]; then
    echo "{{PODMAN_API_ROUTING_B64}}" | base64 -d > /etc/traefik/dynamic/podman-api.yml
    echo "podman-api.yml (mTLS-secured Podman API route) written"
  else
    rm -f /etc/traefik/dynamic/podman-api.yml
    echo "podman-api.yml not written — no base domain, so the Podman API is not published"
  fi

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

  # Pull before writing the version into the units: the digest we pin is the
  # one this run actually fetched and is about to start.
  echo "Pulling container images..."
  podman pull docker.io/crowdsecurity/crowdsec:${CROWDSEC_VERSION} 2>&1 || echo "WARNING: Failed to pull CrowdSec image, using cached"
  podman pull docker.io/traefik:${TRAEFIK_VERSION} 2>&1 || echo "WARNING: Failed to pull Traefik image, using cached"

  # `image@sha256:…` in the unit, so a restart three months from now runs the
  # same bytes even if the tag has been moved under us. Falls back to the
  # pinned tag — still a fixed version, just not byte-exact — when the local
  # image carries no repo digest (built locally, or pulled by digest already).
  local crowdsec_ref="docker.io/crowdsecurity/crowdsec:${CROWDSEC_VERSION}"
  local traefik_ref="docker.io/traefik:${TRAEFIK_VERSION}"
  local crowdsec_digest traefik_digest
  crowdsec_digest=$(resolve_image_digest "$crowdsec_ref")
  traefik_digest=$(resolve_image_digest "$traefik_ref")
  if [ -n "$crowdsec_digest" ]; then
    echo "CrowdSec image pinned to ${crowdsec_digest}"
    crowdsec_ref="$crowdsec_digest"
  else
    echo "WARNING: no repo digest for ${crowdsec_ref}; pinning by tag only"
  fi
  if [ -n "$traefik_digest" ]; then
    echo "Traefik image pinned to ${traefik_digest}"
    traefik_ref="$traefik_digest"
  else
    echo "WARNING: no repo digest for ${traefik_ref}; pinning by tag only"
  fi

  # The units carry `docker.io/<repo>:PLACEHOLDER`, so the substitution has to
  # swallow the tag separator along with the placeholder to leave a bare
  # `docker.io/<repo>@sha256:…`. `|` as the sed delimiter: digests contain `/`.
  sed -i "s|docker.io/crowdsecurity/crowdsec:CROWDSEC_VERSION_PLACEHOLDER|${crowdsec_ref}|g" /etc/systemd/system/crowdsec-container.service
  sed -i "s|docker.io/traefik:TRAEFIK_VERSION_PLACEHOLDER|${traefik_ref}|g" /etc/systemd/system/traefik-container.service

  systemctl daemon-reload
  systemctl enable traefik-container.service
  systemctl enable crowdsec-container.service
  echo "Starting CrowdSec..."
  systemctl start crowdsec-container.service
  sleep 5
  # Verify CrowdSec is running; if not, clean stale data and retry
  if ! podman ps --filter name=crowdsec --format "{{.Names}}" 2>/dev/null | grep -q crowdsec; then
    echo "WARNING: CrowdSec container not running after first attempt"
    echo "CrowdSec container logs:"
    podman logs --tail 30 crowdsec 2>&1 || true
    echo "CrowdSec service journal:"
    journalctl -u crowdsec-container.service --no-pager -n 20 2>/dev/null || true
    echo "Cleaning CrowdSec state and retrying..."
    systemctl stop crowdsec-container.service 2>/dev/null || true
    systemctl reset-failed crowdsec-container.service 2>/dev/null || true
    podman rm -f crowdsec 2>/dev/null || true
    rm -f /var/lib/crowdsec/data/crowdsec.db 2>/dev/null || true
    rm -f /var/lib/crowdsec/data/crowdsec.db-wal 2>/dev/null || true
    rm -f /var/lib/crowdsec/data/crowdsec.db-shm 2>/dev/null || true
    fuser -k 8081/tcp 2>/dev/null || true
    fuser -k 7422/tcp 2>/dev/null || true
    sleep 2
    systemctl start crowdsec-container.service
    sleep 5
    if podman ps --filter name=crowdsec --format "{{.Names}}" 2>/dev/null | grep -q crowdsec; then
      echo "CrowdSec container: running (after retry with clean state)"
    else
      echo "WARNING: CrowdSec still not running after retry"
      podman logs --tail 30 crowdsec 2>&1 || true
      journalctl -u crowdsec-container.service --no-pager -n 30 2>/dev/null || true
    fi
  else
    echo "CrowdSec container: running"
  fi
  echo "Starting Traefik..."
  systemctl start traefik-container.service
  echo "Services started"
}

# ── Execute steps ──────────────────────────────────────────────────────

# Patching is a soft step: a held apt lock or an unreachable mirror must not
# stop a worker from being provisioned, but it must be visible in the log
# rather than swallowed.
soft_step "updates" step_updates
step "podman" step_podman
step "registries" step_registries
step "podman-socket" step_podman_socket
step "cleanup-old" step_cleanup_old
soft_step "firewall" step_firewall
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

# ── Routing configuration fetch (http routing mode only) ───────────────

echo "{{TRAEFIK_CONFIG_SCRIPT_B64}}" | base64 -d > /usr/local/bin/rudder-traefik-config.sh
chmod +x /usr/local/bin/rudder-traefik-config.sh
echo "{{TRAEFIK_CONFIG_SERVICE_B64}}" | base64 -d > /etc/systemd/system/rudder-traefik-config.service
echo "{{TRAEFIK_CONFIG_TIMER_B64}}" | base64 -d > /etc/systemd/system/rudder-traefik-config.timer
systemctl daemon-reload

mkdir -p /etc/rudder
chmod 700 /etc/rudder

# This worker's own identity, in both routing modes.
#
# /api/workers/register picks its target from the hostname in the request body,
# so the shared registration secret cannot say *which* worker is calling and this
# token is what does. It lives here rather than in traefik-config.env because
# that file is removed on a labels-mode run, and workers in both modes register.
if [ -n "{{WORKER_TOKEN}}" ]; then
  umask 077
  cat > /etc/rudder/worker.env <<RWEOF
WORKER_TOKEN={{WORKER_TOKEN}}
RWEOF
  chmod 600 /etc/rudder/worker.env
  umask 022
fi

if [ -n "{{CONFIG_ENDPOINT}}" ]; then
  # The token is a bearer credential for an endpoint that describes every route
  # on this worker, so the file it lives in is never world-readable.
  umask 077
  cat > /etc/rudder/traefik-config.env <<RCEOF
CONFIG_ENDPOINT={{CONFIG_ENDPOINT}}
CONFIG_TOKEN={{CONFIG_TOKEN}}
RCEOF
  chmod 600 /etc/rudder/traefik-config.env
  umask 022

  systemctl enable --now rudder-traefik-config.timer
  # Fetch once synchronously so the worker has its routes before this script
  # reports success, rather than up to a timer period later.
  if /usr/local/bin/rudder-traefik-config.sh; then
    echo "Routing configuration fetched from control plane"
  else
    echo "WARNING: could not fetch routing configuration from {{CONFIG_ENDPOINT}}"
    echo "WARNING: the worker will retry every 10s; applications stay on their"
    echo "WARNING: existing routes until the fetch succeeds."
  fi
else
  # labels routing mode: routing comes from container labels via the docker
  # provider. Leave no stale routes.yml behind from a previous http-mode run,
  # or its routers would shadow the label-derived ones.
  systemctl disable --now rudder-traefik-config.timer 2>/dev/null || true
  rm -f /etc/rudder/traefik-config.env /etc/traefik/dynamic/routes.yml
  echo "Routing mode: labels (container labels drive Traefik)"
fi

# ── Patch-state scan ───────────────────────────────────────────────────
#
# Separate from the metrics timer on purpose: `apt-get -s upgrade` takes
# seconds and contends for the apt lock, which has no business running every
# 30 seconds. This writes a cache the metrics collector reads.

echo "{{UPDATES_SCRIPT_B64}}" | base64 -d > /usr/local/bin/rudder-updates.sh
chmod +x /usr/local/bin/rudder-updates.sh
echo "{{UPDATES_SERVICE_B64}}" | base64 -d > /etc/systemd/system/rudder-updates.service
echo "{{UPDATES_TIMER_B64}}" | base64 -d > /etc/systemd/system/rudder-updates.timer
systemctl daemon-reload
systemctl enable --now rudder-updates.timer
# Populate the cache now so the first metrics collection after provisioning
# already carries patch state, instead of reporting null until the timer runs.
/usr/local/bin/rudder-updates.sh || echo "WARNING: patch-state scan failed; workers report null until the next run"

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
if nft list table inet rudder &>/dev/null; then
  echo "Exposed: 22 (SSH), 443 (Traefik HTTPS) — enforced by nftables"
else
  echo "Exposed: 22 (SSH), 443 (Traefik HTTPS) — NOT enforced, no host firewall"
fi
echo "Internal: 8080 (Podman API), 8081/7422 (CrowdSec), 9100 (metrics), 8082 (Traefik Prometheus) — 127.0.0.1 only"
echo "WAF: CrowdSec AppSec enabled on all applications via Traefik plugin"
# This line used to claim mTLS unconditionally, including on the runs that
# published the Podman API with no client-certificate check at all — the
# operator was told the opposite of what shipped.
if [ -n "{{BASE_DOMAIN}}" ]; then
  echo "Security: Podman API secured with mTLS client certificate authentication"
  echo "Podman API URL: https://podman-api.{{BASE_DOMAIN}}"
  echo "Traefik dashboard: https://traefik.{{BASE_DOMAIN}}/dashboard/"
  echo ""
  echo "NOTE: Let's Encrypt TLS certificates may take 30-60 seconds to obtain on first provision."
  echo "      HTTPS endpoints will return errors until certificates are ready."
else
  echo "Security: Podman API NOT published — no base domain, so it cannot be given an mTLS router"
  echo "Podman API URL: none (reachable only as http://127.0.0.1:8080 on the worker itself)"
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
  echo "WARNING: $FAILURES non-fatal step(s) did not complete: ${SKIPPED}"
  echo "WARNING: the worker is usable but degraded — see the step output above."
fi

echo ""
echo "=== CERTS_BEGIN ==="
echo "CA_CERT_B64=$(cat /etc/traefik/certs/ca.crt | base64 -w 0)"
echo "CLIENT_CERT_B64=$(cat /etc/traefik/certs/client.crt | base64 -w 0)"
echo "CLIENT_KEY_B64=$(cat /etc/traefik/certs/client.key | base64 -w 0)"
echo "BOUNCER_KEY={{BOUNCER_KEY}}"
echo "=== CERTS_END ==="
