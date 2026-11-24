#!/usr/bin/env bash
# Run as root on the target worker from a private staging directory.
# This pilot enables a single application per worker.
set -euo pipefail
umask 077

[[ $# = 3 ]] || { echo "Usage: $0 hostname application-uuid loopback-port" >&2; exit 2; }
host=$1 application=$2 port=$3
[[ $EUID = 0 && $host =~ ^[a-z0-9]+([.-][a-z0-9]+)+$ &&
   $application =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ &&
   $port =~ ^[0-9]{4,5}$ && $port -ge 1024 && $port -le 65535 ]]

prefix="rudder-learning-$application"
gateway="rudder-learning-ingress-$application"
helper="$gateway.service"
install_dir=/etc/rudder/crowdsec-learning
dynamic="/etc/traefik/dynamic/$prefix.yaml"
units=/etc/systemd/system
traefik_config=/etc/traefik/traefik.yml
data_dir=/var/lib/crowdsec/data
bun_image=docker.io/oven/bun:1.4.2-alpine
[[ ! -e $install_dir && ! -e $dynamic && ! -e $units/$helper && -x ./crowdsec ]]
traefik_version=$(podman exec traefik traefik version)
live_version=$(podman exec crowdsec crowdsec -version | sed -n 's/^version: //p')
built_version=$(./crowdsec -version | sed -n 's/^version: //p')
[[ $traefik_version =~ Version:[[:space:]]+3\.8\.0 && $built_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ &&
   ( $live_version = "$built_version" || $live_version = "$built_version"-* ) ]]
systemctl is-active --quiet crowdsec-container.service
systemctl is-active --quiet traefik-container.service
[[ -z $(ss -Hltn "sport = :$port") ]]
podman image exists "$bun_image"
[[ $(curl -sS --max-time 5 --resolve "$host:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$host/learn") = 404 ]]

backup=$(mktemp -d /var/backups/rudder-learning-XXXXXXXX)
echo "Rollback files: $backup"
cp -p "$units"/{crowdsec,traefik}-container.service "$traefik_config" "$backup/"
python3 - "$data_dir/crowdsec.db" "$backup/crowdsec.db" <<'PY'
import sqlite3
import sys
with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as backup:
        source.backup(backup)
PY
api=http://127.0.0.1:8083/api/http/routers
curl -fsS --max-time 5 "$api" | python3 crowdsec-learning-ingress-config.py "$host" "$application" "$port" > "$backup/overlay.json"

cat > "$backup/rollback.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
rm -f '$dynamic'
cp -p '$backup/traefik.yml' '$traefik_config'
cp -p '$backup/crowdsec-container.service' '$backup/traefik-container.service' '$units/'
systemctl disable --now '$helper' || true
rm -f '$units/$helper'
systemctl daemon-reload
systemctl restart crowdsec-container.service traefik-container.service
EOF
changed=0
cleanup() {
  local result=$?
  if (( result != 0 && changed )); then
    bash "$backup/rollback.sh" || echo "Rollback requires attention: $backup/rollback.sh" >&2
  fi
}
trap cleanup EXIT

install -d "$install_dir"/{lab,state} "$install_dir/plugins-local/src/github.com/rudder-learning/ingress"
install -m 0755 ./crowdsec "$install_dir/crowdsec"
install -m 0644 crowdsec-learning-{state,alerts}.ts "$install_dir/lab/"
install -m 0644 crowdsec-learning-spike.ts "$install_dir/lab/gateway.ts"
install -m 0644 crowdsec-learning-ingress/{go.mod,.traefik.yml,ingress.go} "$install_dir/plugins-local/src/github.com/rudder-learning/ingress/"
ingress_key=$(openssl rand -hex 32)
printf 'RUDDER_LEARNING_INGRESS_KEY=%s\n' "$ingress_key" > "$install_dir/ingress.env"
printf 'RUDDER_LEARNING_HOST=%s\n' "$host" >> "$install_dir/ingress.env"
printf 'LEARNING_INGRESS_KEY=%s\nLEARNING_KEY=%s\nLEARNING_ORIGIN=https://%s\nLEARNING_PORT=%s\n' \
  "$ingress_key" "$(openssl rand -hex 32)" "$host" "$port" > "$install_dir/gateway.env"
unset ingress_key

podman run --rm -v "$data_dir:/alerts" -v "$install_dir/lab:/lab:ro" "$bun_image" \
  bun /lab/crowdsec-learning-alerts.ts /alerts/crowdsec.db

changed=1
cat > "$units/$helper" <<EOF
[Unit]
Description=Rudder learning enrollment and capture for $host
After=network.target

[Service]
ExecStartPre=-/usr/bin/podman rm -f $gateway
ExecStart=/usr/bin/podman run --rm --name $gateway --network host \\
  --label io.rudder.crowdsec-learning=gateway \\
  --label io.rudder.crowdsec-learning.origin=https://$host \\
  --label io.rudder.crowdsec-learning.application=$application \\
  --env-file $install_dir/gateway.env \\
  -v $install_dir/lab:/lab:ro -v $install_dir/state:/state -v $data_dir:/alerts:ro \\
  $bun_image bun /lab/gateway.ts
ExecStop=/usr/bin/podman stop $gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

python3 - "$traefik_config" "$units" "$install_dir" <<'PY'
from pathlib import Path
import sys

config, units, root = map(Path, sys.argv[1:])
static = config.read_text()
anchor = "\nexperimental:\n  plugins:\n"
if static.count(anchor) != 1 or "localPlugins:" in static:
    raise SystemExit("Unexpected Traefik plugin configuration")
static = static.replace(anchor, "\nexperimental:\n  localPlugins:\n"
                        "    rudder-learning:\n      moduleName: github.com/rudder-learning/ingress\n  plugins:\n")
for name, mount in (("crowdsec", f"{root}/crowdsec:/usr/local/bin/crowdsec:ro"),
                    ("traefik", f"{root}/plugins-local:/plugins-local:ro")):
    path = units / f"{name}-container.service"
    body = path.read_text()
    command = f"ExecStart=/usr/bin/podman run --name {name} "
    if body.count(command) != 1:
        raise SystemExit(f"Unexpected {name} service")
    start = body.index("\n", body.index(command)) + 1
    options = f"  --env-file {root}/ingress.env -v {mount} " + chr(92) + "\n"
    path.write_text(body[:start] + options + body[start:])
config.write_text(static)
PY

wait_for() {
  for _ in {1..40}; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Readiness check timed out: $*" >&2
  return 1
}
systemctl daemon-reload
systemctl enable --now "$helper"
wait_for curl -fsS --max-time 2 -H "Host: $host" "http://127.0.0.1:$port/learn"
systemctl restart crowdsec-container.service
wait_for podman exec crowdsec cscli lapi status
wait_for curl -sS --max-time 2 http://127.0.0.1:7422/
systemctl restart traefik-container.service
wait_for curl -fsS --max-time 2 "$api"
install -m 0600 "$backup/overlay.json" "/etc/traefik/dynamic/.$prefix.tmp"
mv "/etc/traefik/dynamic/.$prefix.tmp" "$dynamic"
wait_for curl -fsS --max-time 5 --resolve "$host:443:127.0.0.1" "https://$host/learn"
curl -fsS --max-time 5 "$api" | python3 -c '
import json, sys
prefix = sys.argv[1] + "-"
routers = {r["name"].removeprefix(prefix): r["status"] for r in json.load(sys.stdin)
           if r["name"].startswith(prefix)}
assert routers == {"http@file": "enabled", "ws@file": "enabled", "enroll@file": "enabled"}, routers
' "$prefix"
echo "Learning ingress enabled for $host"
