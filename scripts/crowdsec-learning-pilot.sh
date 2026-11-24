#!/usr/bin/env bash
# Run from a private directory containing the pilot scripts and built engine.
# This dedicated stack never mounts the production CrowdSec config or database.
set -euo pipefail
umask 077

host=${1:?Usage: crowdsec-learning-pilot.sh LEARNING_HOST LOOPBACK_PORT APPLICATION_ID}
port=${2:?A free loopback port is required}
application=${3:?An application ID is required}
[[ $host =~ ^crowdsec-learning\.[a-z0-9.-]+$ && $port =~ ^[0-9]{4,5}$ && $application =~ ^[a-zA-Z0-9_-]+$ ]]
origin=https://$host
state_scope=$(printf '%s\0%s' "$application" "$origin" | sha256sum | cut -d' ' -f1)
dir=$(pwd -P)
pod=rudder-learning-pilot
plugin=github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin
for credential in bouncer-key signing-key; do
  if [[ ! -s $credential ]]; then openssl rand -hex 32 > "$credential"; fi
done
bouncer=$(<bouncer-key)
key=$(<signing-key)

cat > app.ts <<'EOF'
Bun.serve({
  hostname: '127.0.0.1',
  port: 8088,
  fetch: (request) => Response.json({
    applicationCookie: request.headers.get('cookie')?.includes('application=control') ?? false,
    learningCookieExposed: request.headers.get('cookie')?.includes('__Host-rudder-learning=') ?? false,
    transactionHeaderExposed: request.headers.has('X-Crowdsec-Appsec-Transaction-Id'),
  }),
});
EOF
cat > acquis.yaml <<'EOF'
source: appsec
listen_addr: 127.0.0.1:7422
appsec_configs:
  - crowdsecurity/appsec-default
  - crowdsecurity/crs
labels:
  type: appsec
EOF
cat > profiles.yaml.local <<'EOF'
name: observe_only_appsec_outofband
filters:
  - Alert.GetScenario() == "crowdsecurity/crowdsec-appsec-outofband"
decisions: []
on_success: break
EOF
cat > traefik.yml <<EOF
entryPoints:
  probe:
    address: 127.0.0.1:8082
providers:
  file:
    filename: /lab/dynamic.yml
experimental:
  plugins:
    bouncer:
      moduleName: $plugin
      version: v1.8.2
EOF
cat > dynamic.yml <<EOF
http:
  routers:
    pilot:
      entryPoints: [probe]
      rule: 'PathPrefix(\`/\`)'
      middlewares: [crowdsec, strip-transaction]
      service: probe
  middlewares:
    crowdsec:
      plugin:
        bouncer:
          enabled: true
          crowdsecMode: stream
          crowdsecLapiHost: 127.0.0.1:8080
          crowdsecLapiKey: $bouncer
          crowdsecAppsecEnabled: true
          crowdsecAppsecHost: 127.0.0.1:7422
    strip-transaction:
      headers:
        customRequestHeaders:
          X-Crowdsec-Appsec-Transaction-Id: ""
  services:
    probe:
      loadBalancer:
        servers: [{url: 'http://127.0.0.1:8088'}]
EOF

podman pod create --name "$pod" -p "127.0.0.1:$port:8079"
mkdir -p state crowdsec-data
common=(--pod "$pod" --label "io.rudder.crowdsec-learning.origin=$origin"
  --label "io.rudder.crowdsec-learning.application=$application")
podman run -d "${common[@]}" --name "$pod-engine" --label io.rudder.crowdsec-learning=engine \
  -e "BOUNCER_KEY_traefik=$bouncer" -e DISABLE_ONLINE_API=true \
  -e 'COLLECTIONS=crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-crs crowdsecurity/appsec-generic-rules' \
  -v "$dir/crowdsec-data:/var/lib/crowdsec/data" \
  -v "$dir/acquis.yaml:/etc/crowdsec/acquis.d/rudder-learning.yaml:ro" \
  -v "$dir/profiles.yaml.local:/etc/crowdsec/profiles.yaml.local:ro" \
  -v "$dir/crowdsec:/usr/local/bin/crowdsec:ro" \
  docker.io/crowdsecurity/crowdsec:v1.8.2
for attempt in $(seq 1 30); do
  if podman exec "$pod-engine" cscli lapi status >/dev/null 2>&1; then break; fi
  if [[ $attempt == 30 ]]; then echo 'Isolated CrowdSec did not start' >&2; exit 1; fi
  sleep 1
done
podman run -d --pod "$pod" --name "$pod-proxy" \
  -v "$dir/traefik.yml:/lab/traefik.yml:ro" -v "$dir/dynamic.yml:/lab/dynamic.yml:ro" \
  docker.io/library/traefik:v3.8.0 --configFile=/lab/traefik.yml
podman run -d --pod "$pod" --name "$pod-app" -v "$dir/app.ts:/lab/app.ts:ro" \
  docker.io/oven/bun:1.4.2-alpine bun /lab/app.ts
podman run -d "${common[@]}" --name "$pod-gateway" --label io.rudder.crowdsec-learning=gateway \
  -v "$dir/crowdsec-learning-spike.ts:/lab/gateway.ts:ro" \
  -v "$dir/crowdsec-learning-state.ts:/lab/crowdsec-learning-state.ts:ro" -v "$dir/state:/state" \
  -e "LEARNING_ORIGIN=$origin" -e "LEARNING_KEY=$key" -e LEARNING_LISTEN_HOST=0.0.0.0 \
  -e "LEARNING_STATE_PATH=/state/$state_scope.sqlite" \
  -e LEARNING_TRAEFIK_PORT=8082 docker.io/oven/bun:1.4.2-alpine bun /lab/gateway.ts

cat > public-route.yml <<EOF
http:
  routers:
    rudder-crowdsec-learning-lab:
      entryPoints: [websecure]
      rule: 'Host(\`$host\`) && (Path(\`/\`) || Path(\`/learn\`) || Path(\`/crowdsec-test-NtktlJHV4TfBSK3wvlhiOBnl\`))'
      tls:
        certResolver: letsencrypt
      service: rudder-crowdsec-learning-lab
  services:
    rudder-crowdsec-learning-lab:
      loadBalancer:
        servers: [{url: 'http://127.0.0.1:$port'}]
EOF
