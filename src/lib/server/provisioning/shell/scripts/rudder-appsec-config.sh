#!/bin/bash
# Fetch this worker's CrowdSec AppSec rule exclusions from the Rudder control
# plane and install them where CrowdSec loads AppSec configurations.
#
# Separate from rudder-traefik-config.sh, and deliberately so:
#
#   * it runs in both routing modes. Which CRS rules an application is exempt
#     from has nothing to do with whether Traefik learns its routes from labels
#     or from a file.
#   * applying it restarts CrowdSec, because AppSec configuration is read at
#     startup. Coupling that to the routing fetch would restart the WAF every
#     time a route changed.
#
# Failure is always "keep what we have": a fetch that fails, times out or
# returns something that is not an AppSec configuration leaves the installed
# file untouched, and CrowdSec is not restarted. The worst case is that an
# exclusion takes effect one poll later than it could have.

set -uo pipefail

ENV_FILE=/etc/rudder/appsec-config.env
TARGET=/etc/rudder/appsec/rudder-exclusions.yaml
STAGE=/etc/rudder/appsec/.rudder-exclusions.next

[ -r "$ENV_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$ENV_FILE"

[ -n "${APPSEC_ENDPOINT:-}" ] || exit 0
[ -n "${APPSEC_TOKEN:-}" ] || { echo "no config token; not fetching"; exit 1; }

mkdir -p /etc/rudder/appsec 2>/dev/null

CURLRC=""
cleanup() { rm -f "$STAGE" ${CURLRC:+"$CURLRC"}; }
trap cleanup EXIT

# Same two-layer authentication as the routing fetch: where the control plane is
# published behind a proxy demanding HTTP Basic, that proxy has to be satisfied
# first or the request never reaches Rudder, so `Authorization` carries Basic and
# the worker's own credential moves to `X-Rudder-Config-Token`.
#
# The Basic credentials go through a curl config file, not `--user`: process
# arguments are world-readable through /proc for as long as curl runs.
if [ -n "${APPSEC_BASIC_USER:-}" ]; then
  CURLRC=$(mktemp)
  chmod 600 "$CURLRC"
  _u=${APPSEC_BASIC_USER//\\/\\\\}; _u=${_u//\"/\\\"}
  _p=${APPSEC_BASIC_PASS:-};        _p=${_p//\\/\\\\}; _p=${_p//\"/\\\"}
  printf 'user = "%s:%s"\n' "$_u" "$_p" > "$CURLRC"
  unset _u _p
  AUTH_ARGS=(-K "$CURLRC" -H "X-Rudder-Config-Token: ${APPSEC_TOKEN}")
else
  AUTH_ARGS=(-H "Authorization: Bearer ${APPSEC_TOKEN}")
fi

if ! curl -fsS --max-time 15 "${AUTH_ARGS[@]}" -o "$STAGE" "$APPSEC_ENDPOINT"; then
  echo "fetch failed — keeping the existing ${TARGET}"
  exit 1
fi

# Reject anything that is not an AppSec configuration before it can replace a
# working one. The name line is Rudder's own and is present in every generated
# document, including the empty one, so this is a real check and not a
# formality: an error page or a truncated body fails it.
if ! grep -q '^name: rudder/exclusions$' "$STAGE"; then
  echo "response is not an AppSec configuration — keeping the existing ${TARGET}"
  exit 1
fi

if [ -f "$TARGET" ] && cmp -s "$STAGE" "$TARGET"; then
  exit 0
fi

# Written in place rather than renamed. The file is bind-mounted into the
# CrowdSec container, and a bind mount follows the inode, not the path — a
# `mv` would leave the container reading the file it started with. Writing
# through the existing inode keeps the two in agreement even if the restart
# below fails.
if [ -f "$TARGET" ]; then
  cat "$STAGE" > "$TARGET"
else
  cp "$STAGE" "$TARGET"
fi
chmod 644 "$TARGET"

echo "AppSec exclusions updated"

# CrowdSec reads AppSec configuration once, at startup. Nothing takes effect
# until it restarts, so a fetch that installed a new file and stopped here would
# report success while changing nothing.
#
# A few seconds with no WAF on this worker is the cost, and it is only paid when
# the document actually changed — which is why the `cmp` above is not an
# optimisation.
#
# "No WAF" and not "no worker", but only because the Traefik middleware sets
# crowdsecAppsecUnreachableBlock and crowdsecAppsecFailureBlock to false. The
# plugin defaults both to true, and with those defaults this restart returned
# 403 from every application on the worker until CrowdSec came back — an outage
# caused by a rule exclusion, and invisible in Rudder, since a bouncer-side 403
# creates no alert and no decision. Anything that changes those two settings
# changes what this restart costs.
if systemctl is-active --quiet crowdsec-container.service; then
  if systemctl restart crowdsec-container.service; then
    echo "CrowdSec restarted"
  else
    echo "WARNING: could not restart CrowdSec; the new exclusions are installed"
    echo "WARNING: but will not take effect until it restarts."
    exit 1
  fi
fi
