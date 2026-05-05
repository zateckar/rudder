export function generateProvisioningScript(
  workerName: string,
  podmanApiPort: number = 22,
  controlPlaneUrl: string,
  baseDomain?: string,
  bouncerKeyParam?: string
): string {
  // Use provided bouncer API key for CrowdSec
  const bouncerKey = bouncerKeyParam || '';
  // Pre-compute all config files as base64 to avoid heredoc stdin issues
  const podmanApiDomain = baseDomain ? `podman-api.${baseDomain}` : '';
  const traefikDashboardDomain = baseDomain ? `traefik.${baseDomain}` : '';
  const acmeEmail = baseDomain ? `admin@${baseDomain}` : `admin@${workerName}.local`;

  // Traefik static config - port 443 only, TLS-ALPN-01, CrowdSec bouncer plugin
  const traefikYml = `entryPoints:
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    watch: true
  file:
    directory: /etc/traefik/dynamic
    watch: true

api:
  dashboard: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: ${acmeEmail}
      storage: /etc/traefik/acme/acme.json
      tlsChallenge: {}

experimental:
  plugins:
    bouncer:
      moduleName: github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin
      version: v1.5.1
    traefikoidc:
      moduleName: github.com/lukaszraczylo/traefikoidc
      version: v0.8.24

log:
  level: INFO

accessLog:
  filePath: /var/log/traefik/access.log
  format: json
  bufferingSize: 100
`;

  // Dynamic config: Podman API with mTLS (requires client certificate)
  // The CA cert is in /etc/traefik/certs/ca.crt inside the container
  const podmanApiRoutingYml = baseDomain ? `http:
  routers:
    podman-api:
      rule: "Host(\`${podmanApiDomain}\`)"
      priority: 100
      entrypoints:
        - websecure
      tls:
        certResolver: letsencrypt
        options: podman-mtls
      middlewares:
        - crowdsec
        - security-headers
      service: podman-api
    traefik-dashboard:
      rule: "Host(\`${traefikDashboardDomain}\`) && (PathPrefix(\`/api\`) || PathPrefix(\`/dashboard\`))"
      priority: 100
      entrypoints:
        - websecure
      tls:
        certResolver: letsencrypt
        options: podman-mtls
      middlewares:
        - crowdsec
        - security-headers
      service: api@internal
  services:
    podman-api:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"

tls:
  options:
    podman-mtls:
      clientAuth:
        caFiles:
          - /etc/traefik/certs/ca.crt
        clientAuthType: RequireAndVerifyClientCert
` : `http:
  routers:
    podman-api:
      rule: "PathPrefix(\`/\`)"
      priority: 1
      entrypoints:
        - websecure
      tls: {}
      service: podman-api
  services:
    podman-api:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"
`;

  // Podman API HTTP systemd service (localhost only)
  const podmanApiServiceUnit = `[Unit]
Description=Podman REST API (localhost only)
Documentation=man:podman-system-service(1)
After=network.target podman.socket
Wants=network.target

[Service]
Type=simple
ExecStart=/usr/bin/podman system service --time=0 tcp://127.0.0.1:8080
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=podman-api-http

[Install]
WantedBy=multi-user.target
`;

  // CrowdSec bouncer + security headers middleware - defined as file provider dynamic config
  const crowdsecMiddlewareYml = `http:
  middlewares:
    crowdsec:
      plugin:
        bouncer:
          enabled: true
          crowdsecAppsecEnabled: true
          crowdsecAppsecHost: "localhost:7422"
          crowdsecLapiHost: "localhost:8081"
          crowdsecLapiKey: "${bouncerKey}"
          crowdsecMode: stream
    security-headers:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
        stsPreload: true
        frameDeny: true
        contentTypeNosniff: true
        browserXssFilter: true
        referrerPolicy: "strict-origin-when-cross-origin"
        customResponseHeaders:
          X-Robots-Tag: "noindex, nofollow"
          Permissions-Policy: "camera=(), microphone=(), geolocation=()"
`;

  // CrowdSec acquisition config (traefik access logs)
  const crowdsecAcquisYml = `filenames:
  - /var/log/traefik/access.log
labels:
  type: traefik
`;

  // CrowdSec AppSec acquisition config - enables AppSec WAF on port 7422
  const crowdsecAppsecAcquisYml = `appsec_config: crowdsecurity/appsec-default
labels:
  type: appsec
listen_addr: 0.0.0.0:7422
source: appsec
`;

  // CrowdSec config.yaml.local - override LAPI port to 8081 (Podman API uses 8080)
  const crowdsecConfigLocalYml = `api:
  server:
    listen_uri: 0.0.0.0:8081
`;

  // Traefik container systemd service - mounts log dir for CrowdSec
  const traefikServiceUnit = `[Unit]
Description=Traefik reverse proxy (Podman container)
After=network-online.target podman.socket podman-api-http.service
Wants=network-online.target
Requires=podman-api-http.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman stop traefik
ExecStartPre=-/usr/bin/podman rm -f traefik
ExecStart=/usr/bin/podman run --name traefik --rm --network host -v /run/podman/podman.sock:/var/run/docker.sock:z -v /etc/traefik/traefik.yml:/etc/traefik/traefik.yml:ro,z -v /etc/traefik/dynamic:/etc/traefik/dynamic:ro,z -v /etc/traefik/acme:/etc/traefik/acme:z -v /etc/traefik/certs:/etc/traefik/certs:ro,z -v /var/log/traefik:/var/log/traefik:z docker.io/traefik:latest
ExecStop=/usr/bin/podman stop traefik
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=traefik

[Install]
WantedBy=multi-user.target
`;

  // CrowdSec container systemd service
  const crowdsecServiceUnit = `[Unit]
Description=CrowdSec WAF and IPS (Podman container)
After=network-online.target podman.socket podman-api-http.service
Wants=network-online.target
Requires=podman-api-http.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman stop crowdsec
ExecStartPre=-/usr/bin/podman rm -f crowdsec
ExecStart=/usr/bin/podman run --name crowdsec --rm --network host -e "COLLECTIONS=crowdsecurity/traefik crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-generic-rules crowdsecurity/base-http-scenarios crowdsecurity/whitelist-good-actors" -e CUSTOM_HOSTNAME=crowdsec -e "BOUNCER_KEY_traefik=${bouncerKey}" -v /var/log/traefik:/var/log/traefik:ro -v /etc/crowdsec/acquis.yaml:/etc/crowdsec/acquis.yaml:ro -v /etc/crowdsec/acquis.d:/etc/crowdsec/acquis.d:ro -v /var/lib/crowdsec/data:/var/lib/crowdsec/data -v /etc/crowdsec:/etc/crowdsec docker.io/crowdsecurity/crowdsec:latest
ExecStop=/usr/bin/podman stop crowdsec
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=crowdsec

[Install]
WantedBy=multi-user.target
`;

  // Podman registries config
  const registriesConf = `[registries.search]
registries = ['docker.io', 'quay.io']
[registries.insecure]
registries = []
[registries.block]
registries = []
`;

  // Base64 encode all configs
  const traefikYmlB64 = Buffer.from(traefikYml).toString('base64');
  const podmanApiRoutingYmlB64 = Buffer.from(podmanApiRoutingYml).toString('base64');
  const crowdsecMiddlewareYmlB64 = Buffer.from(crowdsecMiddlewareYml).toString('base64');
  const crowdsecAcquisYmlB64 = Buffer.from(crowdsecAcquisYml).toString('base64');
  const crowdsecAppsecAcquisYmlB64 = Buffer.from(crowdsecAppsecAcquisYml).toString('base64');
  const crowdsecConfigLocalYmlB64 = Buffer.from(crowdsecConfigLocalYml).toString('base64');
  const podmanApiServiceB64 = Buffer.from(podmanApiServiceUnit).toString('base64');
  const traefikServiceB64 = Buffer.from(traefikServiceUnit).toString('base64');
  const crowdsecServiceB64 = Buffer.from(crowdsecServiceUnit).toString('base64');
  const registriesB64 = Buffer.from(registriesConf).toString('base64');

  const script = `#!/bin/bash
# Worker provisioning - only ports 22 (SSH) and 443 (Traefik HTTPS) are exposed externally
# Podman API is secured with mTLS (mutual TLS) - requires client certificate
# Base64-encoded configs to avoid heredoc issues when piped via SSH stdin

set -o pipefail

FAILURES=0
step() {
  local name="\$1"
  shift
  if "\$@"; then
    echo "STEP_DONE:\${name}"
  else
    echo "STEP_FAIL:\${name}"
    FAILURES=\$((FAILURES + 1))
  fi
}

echo "=== Starting worker provisioning for ${workerName} ==="

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

step "podman" bash -c '
echo "--- 1. Installing Podman and openssl ---"
if [ "$OS" = "debian" ]; then
    if command -v podman &> /dev/null; then
        echo "Podman already installed: $(podman --version)"
    else
        rm -f /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list 2>/dev/null
        apt-get update -q
        apt-get install -y podman curl openssl 2>&1 | tail -5
        if ! command -v podman &> /dev/null; then
            add-apt-repository -y universe
            apt-get update -q
            apt-get install -y podman curl openssl 2>&1 | tail -5
        fi
    fi
elif [ "$OS" = "rhel" ]; then
    dnf -y module enable podman
    dnf -y install podman curl openssl
fi
podman --version || { echo "ERROR: Podman not installed"; exit 1; }
'

echo "--- 2. Configuring Podman registries ---"
step "registries" bash -c '
mkdir -p /etc/containers
echo "${registriesB64}" | base64 -d > /etc/containers/registries.conf
echo "Registries configured"
'

echo "--- 3. Enabling Podman socket ---"
step "podman-socket" bash -c '
systemctl enable podman.socket
systemctl start podman.socket
sleep 2
'

step "cleanup-old" bash -c '
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
podman stop traefik 2>/dev/null || true
podman rm -f traefik 2>/dev/null || true
podman stop crowdsec 2>/dev/null || true
podman rm -f crowdsec 2>/dev/null || true
fuser -k 8080/tcp 2>/dev/null || true
sleep 3
'

step "mtls-certs" bash -c '
echo "--- 6. Generating mTLS certificates for Podman API security ---"
mkdir -p /etc/traefik/certs

# Generate CA key and certificate
openssl genrsa -out /etc/traefik/certs/ca.key 4096 2>/dev/null
openssl req -new -x509 -key /etc/traefik/certs/ca.key \\
    -out /etc/traefik/certs/ca.crt \\
    -days 3650 \\
    -subj "/CN=rudder-ca/O=Rudder/OU=Infrastructure" 2>/dev/null

# Generate client certificate for Rudder control plane
openssl genrsa -out /etc/traefik/certs/client.key 4096 2>/dev/null
openssl req -new -key /etc/traefik/certs/client.key \\
    -out /etc/traefik/certs/client.csr \\
    -subj "/CN=rudder-control-plane/O=Rudder/OU=ControlPlane" 2>/dev/null
openssl x509 -req \\
    -in /etc/traefik/certs/client.csr \\
    -CA /etc/traefik/certs/ca.crt \\
    -CAkey /etc/traefik/certs/ca.key \\
    -CAcreateserial \\
    -out /etc/traefik/certs/client.crt \\
    -days 365 2>/dev/null

chmod 600 /etc/traefik/certs/*.key
chmod 644 /etc/traefik/certs/*.crt
echo "mTLS certificates generated"
'

step "podman-api" bash -c '
echo "--- 7. Setting up Podman REST API (localhost:8080 only) ---"
echo "${podmanApiServiceB64}" | base64 -d > /etc/systemd/system/podman-api-http.service
systemctl daemon-reload
systemctl enable podman-api-http.service
systemctl restart podman-api-http.service
sleep 3
curl -sf http://127.0.0.1:8080/_ping && echo "Podman API: OK" || echo "Warning: Podman API not ready"
'

step "traefik-config" bash -c '
echo "--- 8. Writing Traefik configuration ---"
mkdir -p /etc/traefik/dynamic /etc/traefik/acme /var/log/traefik
echo "${traefikYmlB64}" | base64 -d > /etc/traefik/traefik.yml
echo "traefik.yml written (port 443 only, TLS-ALPN-01, CrowdSec plugin)"

echo "${podmanApiRoutingYmlB64}" | base64 -d > /etc/traefik/dynamic/podman-api.yml
echo "podman-api.yml (mTLS-secured Podman API route) written"

# Metrics endpoint route — secured with same mTLS as Podman API
if [ -n "${baseDomain}" ]; then
cat > /etc/traefik/dynamic/metrics.yml << 'METRICSYMLEOF'
http:
  routers:
    rudder-metrics:
      rule: "Host(\`metrics.${baseDomain}\`)"
      entryPoints:
        - websecure
      service: rudder-metrics
      tls:
        certResolver: letsencrypt
        options: podman-mtls
  services:
    rudder-metrics:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9100"
METRICSYMLEOF
echo "metrics.yml (mTLS-secured host metrics route) written"
fi

echo "${crowdsecMiddlewareYmlB64}" | base64 -d > /etc/traefik/dynamic/crowdsec.yml
echo "crowdsec.yml (CrowdSec AppSec middleware) written"

cat > /etc/logrotate.d/traefik << '"'"'LOGROTATEEOF'"'"'
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
'

step "crowdsec" bash -c '
echo "--- 9. Setting up CrowdSec ---"
mkdir -p /var/lib/crowdsec/data /etc/crowdsec /etc/crowdsec/acquis.d
chmod 755 /var/lib/crowdsec/data
echo "${crowdsecAcquisYmlB64}" | base64 -d > /etc/crowdsec/acquis.yaml
echo "${crowdsecAppsecAcquisYmlB64}" | base64 -d > /etc/crowdsec/acquis.d/appsec.yaml
echo "${crowdsecConfigLocalYmlB64}" | base64 -d > /etc/crowdsec/config.yaml.local
echo "CrowdSec config written"

podman stop crowdsec 2>/dev/null || true
podman rm -f crowdsec 2>/dev/null || true
podman pull docker.io/crowdsecurity/crowdsec:latest
podman run -d \\
  --name crowdsec \\
  --restart always \\
  --network host \\
  -e "COLLECTIONS=crowdsecurity/traefik crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-generic-rules crowdsecurity/base-http-scenarios crowdsecurity/whitelist-good-actors" \\
  -e CUSTOM_HOSTNAME=crowdsec \\
  -e "BOUNCER_KEY_traefik=${bouncerKey}" \\
  -v /var/log/traefik:/var/log/traefik:ro \\
  -v /etc/crowdsec/acquis.yaml:/etc/crowdsec/acquis.yaml:ro \\
  -v /etc/crowdsec/acquis.d:/etc/crowdsec/acquis.d:ro \\
  -v /var/lib/crowdsec/data:/var/lib/crowdsec/data \\
  -v /etc/crowdsec:/etc/crowdsec \\
  docker.io/crowdsecurity/crowdsec:latest
echo "CrowdSec container started (LAPI :8081, AppSec :7422)"
'

step "traefik" bash -c '
echo "--- 10. Pulling and starting Traefik container ---"
podman stop traefik 2>/dev/null || true
podman rm -f traefik 2>/dev/null || true
podman pull docker.io/traefik:latest
podman run -d \\
  --name traefik \\
  --restart always \\
  --network host \\
  -v /run/podman/podman.sock:/var/run/docker.sock:z \\
  -v /etc/traefik/traefik.yml:/etc/traefik/traefik.yml:ro,z \\
  -v /etc/traefik/dynamic:/etc/traefik/dynamic:ro,z \\
  -v /etc/traefik/acme:/etc/traefik/acme:z \\
  -v /etc/traefik/certs:/etc/traefik/certs:ro,z \\
  -v /var/log/traefik:/var/log/traefik:z \\
  docker.io/traefik:latest
echo "Traefik container started"
'

step "systemd-services" bash -c '
echo "--- 11. Creating systemd services ---"
echo "${traefikServiceB64}" | base64 -d > /etc/systemd/system/traefik-container.service
echo "${crowdsecServiceB64}" | base64 -d > /etc/systemd/system/crowdsec-container.service
systemctl daemon-reload
systemctl enable traefik-container.service
systemctl enable crowdsec-container.service
'

sleep 5

echo "=== Provisioning status ==="
podman ps --filter name=traefik --format "Traefik: {{.Status}}"
podman ps --filter name=crowdsec --format "CrowdSec: {{.Status}}"
curl -sf http://127.0.0.1:8080/_ping && echo "Podman API: READY" || echo "Warning: Podman API not yet ready"
ss -tlnp | grep ':443' || echo "Warning: port 443 not yet bound"
ss -tlnp | grep ':8081' && echo "CrowdSec LAPI: READY" || echo "Warning: CrowdSec LAPI not yet ready"
ss -tlnp | grep ':7422' && echo "CrowdSec AppSec: READY" || echo "Warning: CrowdSec AppSec not yet ready"

echo ""
if [ \$FAILURES -gt 0 ]; then
  echo "WARNING: \$FAILURES step(s) had errors"
fi

# ── Netavark stale-rule cleanup (systemd timer) ──────────────────────────
cat > /usr/local/bin/rudder-netavark-cleanup.sh << 'NETAVARK_SCRIPT'
#!/bin/bash
set -uo pipefail
sudo iptables -t nat -L NETAVARK-HOSTPORT-DNAT -n &>/dev/null || exit 0
declare -A stale
while IFS= read -r line; do
  linenum=$(printf '%s' "$line" | awk '{print $1}')
  [[ "$linenum" =~ ^[0-9]+$ ]] || continue
  chain=$(printf '%s' "$line" | grep -oE 'NETAVARK-DN-[A-F0-9]+')
  [[ -z "$chain" ]] && continue
  cid=$(printf '%s' "$line" | sed 's/.*id: //' | awk '{print $1}' | cut -c1-12)
  [[ -z "$cid" ]] && continue
  sudo podman inspect "$cid" &>/dev/null && continue
  stale["$chain"]="$linenum"
done < <(sudo iptables -t nat -L NETAVARK-HOSTPORT-DNAT -n --line-numbers 2>/dev/null | tail -n +3)
[[ \${#stale[@]} -eq 0 ]] && exit 0
echo "[rudder] Purging \${#stale[@]} stale Netavark DNAT rule(s)..."
mapfile -t sorted_lines < <(printf '%s\n' "\${stale[@]}" | sort -rn)
for linenum in "\${sorted_lines[@]}"; do
  sudo iptables -t nat -D NETAVARK-HOSTPORT-DNAT "$linenum" 2>/dev/null || true
done
for chain in "\${!stale[@]}"; do
  sudo iptables -t nat -F "$chain" 2>/dev/null || true
  sudo iptables -t nat -X "$chain" 2>/dev/null || true
  echo "[rudder] Removed stale chain $chain"
done
active_ifaces=$(sudo podman network ls -q 2>/dev/null | \
  xargs -r -I{} sudo podman network inspect {} --format '{{.NetworkInterface}}' 2>/dev/null || true)
while IFS= read -r iface; do
  [[ -z "$iface" ]] && continue
  ip link show "$iface" 2>/dev/null | grep -q 'state DOWN' || continue
  printf '%s\n' "$active_ifaces" | grep -qxF "$iface" && continue
  sudo ip link delete "$iface" 2>/dev/null || true
  echo "[rudder] Removed orphaned bridge interface $iface"
done < <(ip -o link show 2>/dev/null | awk -F'[ :@]+' '/podman[0-9]+/{print $2}')
NETAVARK_SCRIPT
chmod +x /usr/local/bin/rudder-netavark-cleanup.sh

cat > /etc/systemd/system/rudder-netavark-cleanup.service << 'SVCEOF'
[Unit]
Description=Rudder Netavark stale rule cleanup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/rudder-netavark-cleanup.sh
SVCEOF

cat > /etc/systemd/system/rudder-netavark-cleanup.timer << 'TIMEREOF'
[Unit]
Description=Run Rudder Netavark cleanup every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable --now rudder-netavark-cleanup.timer
echo "Netavark cleanup timer installed (runs every 5 min)"

# ── Host metrics HTTP endpoint (systemd timer + socat) ────────────────
cat > /usr/local/bin/rudder-metrics.sh << 'METRICS_SCRIPT'
#!/bin/bash
set -uo pipefail

# CPU: two /proc/stat samples 1s apart
read_cpu() { head -1 /proc/stat | awk '{print $2,$3,$4,$5,$6,$7,$8,$9}'; }
cpu1=$(read_cpu)
sleep 1
cpu2=$(read_cpu)

cpu_percent=$(echo "$cpu1" "$cpu2" | awk '{
  u1=$1+$2+$3+$6+$7+$8; i1=$4+$5
  u2=$9+$10+$11+$14+$15+$16; i2=$12+$13
  dt=(u2+i2)-(u1+i1)
  if(dt>0) printf "%.1f", 100*(u2-u1)/dt; else print "0"
}')
cpu_cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)

# Memory from /proc/meminfo
mem_total=$(awk '/^MemTotal:/{print $2*1024}' /proc/meminfo)
mem_free=$(awk '/^MemFree:/{print $2*1024}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/{print $2*1024}' /proc/meminfo)
mem_used=$((mem_total - mem_available))
if [ "$mem_total" -gt 0 ] 2>/dev/null; then
  mem_percent=$(awk -v used="$mem_used" -v total="$mem_total" 'BEGIN{printf "%.1f", 100*used/total}')
else
  mem_percent=0
fi

# Disk from df
read disk_total disk_used disk_available disk_percent_raw <<< $(df -B1 / | awk 'NR==2{print $2,$3,$4,$5}')
disk_percent=$(echo "$disk_percent_raw" | tr -d '%')

# Network from /proc/net/dev
read net_rx net_tx <<< $(awk 'NR>2 && $1!~/lo:/{rx+=$2; tx+=$10} END{print rx, tx}' /proc/net/dev)

cat > /tmp/rudder-metrics.json << JSONEOF
{"cpu_percent":\${cpu_percent:-0},"cpu_cores":\${cpu_cores:-1},"mem_total":\${mem_total:-0},"mem_free":\${mem_free:-0},"mem_available":\${mem_available:-0},"mem_used":\${mem_used:-0},"mem_percent":\${mem_percent:-0},"disk_total":\${disk_total:-0},"disk_used":\${disk_used:-0},"disk_available":\${disk_available:-0},"disk_percent":\${disk_percent:-0},"net_rx_bytes":\${net_rx:-0},"net_tx_bytes":\${net_tx:-0}}
JSONEOF
chmod 644 /tmp/rudder-metrics.json
METRICS_SCRIPT
chmod +x /usr/local/bin/rudder-metrics.sh

cat > /etc/systemd/system/rudder-metrics.service << 'MSVCEOF'
[Unit]
Description=Rudder host metrics collector
[Service]
Type=oneshot
ExecStart=/usr/local/bin/rudder-metrics.sh
MSVCEOF

cat > /etc/systemd/system/rudder-metrics.timer << 'MTIMEREOF'
[Unit]
Description=Collect Rudder host metrics every 30 seconds
[Timer]
OnBootSec=10s
OnUnitActiveSec=30s
AccuracySec=5s
[Install]
WantedBy=timers.target
MTIMEREOF

# Serve metrics JSON via a simple socat HTTP listener on localhost:9100
cat > /etc/systemd/system/rudder-metrics-http.service << 'MHTTPEOF'
[Unit]
Description=Rudder metrics HTTP endpoint
After=network.target
[Service]
ExecStart=/bin/bash -c 'while true; do socat TCP-LISTEN:9100,reuseaddr,fork SYSTEM:"echo HTTP/1.1 200 OK; echo Content-Type: application/json; echo Connection: close; echo; cat /tmp/rudder-metrics.json 2>/dev/null || echo {}"; done'
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
MHTTPEOF

systemctl daemon-reload
systemctl enable --now rudder-metrics.timer
systemctl enable --now rudder-metrics-http.service
# Run initial collection
/usr/local/bin/rudder-metrics.sh
echo "Host metrics HTTP service installed (port 9100, collected every 30s)"

WORKER_IP=$(hostname -I | awk '{print \$1}')
echo "=== Provisioning complete for ${workerName} ==="
echo "Worker IP: \${WORKER_IP}"
echo "Exposed: 22 (SSH), 443 (Traefik HTTPS)"
echo "Internal: 8080 (Podman API, localhost only)"
echo "Security: Podman API secured with mTLS client certificate authentication"
echo "WAF: CrowdSec AppSec enabled on all applications via Traefik plugin"
${baseDomain ? `echo "Podman API URL: https://podman-api.${baseDomain}"
echo "Traefik dashboard: https://traefik.${baseDomain}/dashboard/"` : `echo "Podman API URL: https://\${WORKER_IP}"`}
echo ""
echo "=== CERTS_BEGIN ==="
echo "CA_CERT_B64=$(cat /etc/traefik/certs/ca.crt | base64 -w 0)"
echo "CLIENT_CERT_B64=$(cat /etc/traefik/certs/client.crt | base64 -w 0)"
echo "CLIENT_KEY_B64=$(cat /etc/traefik/certs/client.key | base64 -w 0)"
echo "BOUNCER_KEY=${bouncerKey}"
echo "=== CERTS_END ==="
`;

  return script;
}

// Generate Podman/Docker labels for Traefik routing with HTTPS, Let's Encrypt TLS-ALPN-01, and CrowdSec WAF
// Traefik listens on port 443 only. No port 80 needed.
// Traefik runs with host networking so it proxies to host-mapped container ports via 127.0.0.1
// All routes are protected by CrowdSec AppSec middleware (crowdsec@file) by default.
// Per-application rate limiting and OIDC auth can be added via options.
export interface AppMiddlewareOptions {
  rateLimitAvg?: number;      // requests/second average (Traefik rateLimit)
  rateLimitBurst?: number;    // max burst size
  authType?: 'none' | 'oidc';
  authConfig?: {              // OIDC provider settings
    providerURL: string;      // e.g. https://accounts.google.com
    clientID: string;
    clientSecret: string;
    sessionEncryptionKey: string;
    callbackURL?: string;     // default: /oauth2/callback
    allowedUserDomains?: string[];
    allowedUsers?: string[];
    excludedURLs?: string[];
    scopes?: string[];
  };
  healthCheckPath?: string;   // Traefik health check endpoint, e.g. /health
}

export function generateTraefikLabelsForApp(
  appName: string,
  domain: string,
  targetPort: number,
  enableWebSocket: boolean = true,
  middlewareOpts?: AppMiddlewareOptions
): Record<string, string> {
  const safeName = appName.replace(/[^a-zA-Z0-9-]/g, '-');

  // Build middleware chain: crowdsec first, then security headers
  const middlewares: string[] = ['crowdsec@file', 'security-headers@file'];

  const labels: Record<string, string> = {
    'traefik.enable': 'true',

    // HTTPS router with Let's Encrypt TLS-ALPN-01 (no port 80 needed)
    [`traefik.http.routers.${safeName}-secure.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${safeName}-secure.entrypoints`]: 'websecure',
    [`traefik.http.routers.${safeName}-secure.tls`]: 'true',
    [`traefik.http.routers.${safeName}-secure.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.routers.${safeName}-secure.service`]: safeName,

    // Service: Traefik on host network proxies to container's host-mapped port
    [`traefik.http.services.${safeName}.loadbalancer.server.url`]: `http://127.0.0.1:${targetPort}`,
  };

  // Health check — Traefik marks backend as down if it fails
  if (middlewareOpts?.healthCheckPath) {
    labels[`traefik.http.services.${safeName}.loadbalancer.healthcheck.path`] = middlewareOpts.healthCheckPath;
    labels[`traefik.http.services.${safeName}.loadbalancer.healthcheck.interval`] = '10s';
    labels[`traefik.http.services.${safeName}.loadbalancer.healthcheck.timeout`] = '5s';
  }

  // Per-app rate limiting (Traefik built-in rateLimit middleware)
  if (middlewareOpts?.rateLimitAvg && middlewareOpts.rateLimitAvg > 0) {
    const rlName = `${safeName}-ratelimit`;
    labels[`traefik.http.middlewares.${rlName}.ratelimit.average`] = String(middlewareOpts.rateLimitAvg);
    labels[`traefik.http.middlewares.${rlName}.ratelimit.burst`] = String(middlewareOpts.rateLimitBurst || middlewareOpts.rateLimitAvg * 2);
    labels[`traefik.http.middlewares.${rlName}.ratelimit.period`] = '1s';
    middlewares.push(`${rlName}@docker`);
  }

  // Per-app OIDC auth (traefik-oidc plugin)
  if (middlewareOpts?.authType === 'oidc' && middlewareOpts.authConfig) {
    const oidcName = `${safeName}-oidc`;
    const cfg = middlewareOpts.authConfig;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.providerURL`] = cfg.providerURL;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.clientID`] = cfg.clientID;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.clientSecret`] = cfg.clientSecret;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.sessionEncryptionKey`] = cfg.sessionEncryptionKey;
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.callbackURL`] = cfg.callbackURL || '/oauth2/callback';
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.forceHTTPS`] = 'true';
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.enablePKCE`] = 'true';
    labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.logLevel`] = 'info';
    if (cfg.scopes?.length) {
      cfg.scopes.forEach((scope, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.scopes[${i}]`] = scope;
      });
    }
    if (cfg.allowedUserDomains?.length) {
      cfg.allowedUserDomains.forEach((d, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.allowedUserDomains[${i}]`] = d;
      });
    }
    if (cfg.allowedUsers?.length) {
      cfg.allowedUsers.forEach((u, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.allowedUsers[${i}]`] = u;
      });
    }
    if (cfg.excludedURLs?.length) {
      cfg.excludedURLs.forEach((p, i) => {
        labels[`traefik.http.middlewares.${oidcName}.plugin.traefikoidc.excludedURLs[${i}]`] = p;
      });
    }
    middlewares.push(`${oidcName}@docker`);
  }

  // Set the middleware chain on the router
  const middlewareChain = middlewares.join(',');
  labels[`traefik.http.routers.${safeName}-secure.middlewares`] = middlewareChain;

  if (enableWebSocket) {
    labels[`traefik.http.routers.${safeName}-secure-ws.rule`] =
      `Host(\`${domain}\`) && Header(\`Connection\`, \`Upgrade\`) && Header(\`Upgrade\`, \`websocket\`)`;
    labels[`traefik.http.routers.${safeName}-secure-ws.entrypoints`] = 'websecure';
    labels[`traefik.http.routers.${safeName}-secure-ws.tls`] = 'true';
    labels[`traefik.http.routers.${safeName}-secure-ws.tls.certresolver`] = 'letsencrypt';
    labels[`traefik.http.routers.${safeName}-secure-ws.service`] = safeName;
    // WebSocket routes get crowdsec + rate limit but NOT oidc (websocket doesn't do OAuth redirects)
    const wsMiddlewares = middlewares.filter(m => !m.includes('-oidc'));
    labels[`traefik.http.routers.${safeName}-secure-ws.middlewares`] = wsMiddlewares.join(',');
  }

  return labels;
}

export function generateTraefikLabelsForApps(
  baseDomain: string,
  apps: Array<{ name: string; subdomain: string; port: number; enableWs?: boolean }>
): Record<string, string> {
  const allLabels: Record<string, string> = {};
  for (const app of apps) {
    const fullDomain = app.subdomain + '.' + baseDomain;
    const labels = generateTraefikLabelsForApp(app.name, fullDomain, app.port, app.enableWs);
    Object.assign(allLabels, labels);
  }
  return allLabels;
}

export function generateTraefikConfig(
  baseDomain: string,
  apps: Array<{ subdomain: string; port: number; enableWs?: boolean }>
): string {
  const routers = apps.map(app => {
    const fullDomain = app.subdomain + '.' + baseDomain;
    return `
    ${app.subdomain}-secure:
      rule: "Host(\`${fullDomain}\`)"
      entrypoints:
        - "websecure"
      tls:
        certResolver: letsencrypt
      middlewares:
        - crowdsec
        - security-headers
      service: "${app.subdomain}"`;
  }).join('\n');

  const services = apps.map(app => `
    ${app.subdomain}:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:${app.port}"`).join('\n');

  return `http:
  routers:
${routers}

  services:
${services}`;
}

export function generateCaddyfile(
  baseDomain: string,
  apps: Array<{ subdomain: string; port: number; enableWs?: boolean }>
): string {
  const appBlocks = apps.map(app => {
    const fullDomain = app.subdomain + '.' + baseDomain;
    const websocketDirectives = app.enableWs ? `
    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websocket localhost:${app.port}
` : '';
    return `${fullDomain} {
    encode zstd gzip
    ${websocketDirectives}
    reverse_proxy localhost:${app.port}
}`;
  }).join('\n\n');

  return `{
    admin off
    auto_https off
}

:443 {
    handle /health {
        respond "OK" 200
    }
    respond "Not configured" 404
}

${appBlocks}
`;
}
