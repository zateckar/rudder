#!/bin/bash
BOUNCER_KEY="{{BOUNCER_KEY}}"
if [ -z "$BOUNCER_KEY" ]; then
  echo "[rudder-crowdsec] WARNING: No bouncer key provided. Skipping registration."
  exit 0
fi


echo "[rudder-crowdsec] Waiting for CrowdSec LAPI on port 8081 (image may still be pulling)..."
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8081/health > /dev/null 2>&1; then
    echo "[rudder-crowdsec] CrowdSec LAPI is ready"
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "[rudder-crowdsec] ERROR: Timed out waiting for CrowdSec LAPI after 15 minutes"
    exit 1
  fi
  sleep 10
done
# Remove any stale bouncer registration (different key from previous provisioning)
# Register bouncer.
podman exec crowdsec cscli bouncers delete traefik 2>/dev/null || true
if podman exec crowdsec cscli bouncers add traefik --key "$BOUNCER_KEY" > /dev/null 2>&1; then
  echo "[rudder-crowdsec] Bouncer key registered successfully"
  sleep 5
  systemctl restart traefik-container.service
  echo "[rudder-crowdsec] Traefik restarted with valid CrowdSec connection"
else
  echo "[rudder-crowdsec] ERROR: Failed to register bouncer key via cscli"
  exit 1
fi
