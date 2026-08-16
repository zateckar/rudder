#!/bin/bash
# Fetch this worker's routing configuration from the Rudder control plane and
# install it where Traefik's file provider will pick it up.
#
# Why a fetch loop rather than Traefik's own `providers.http`: measured on
# Traefik 3.7.10, the http provider holds its last good configuration through a
# refused connection, a 500 and a malformed body — but that state is in memory
# only. A Traefik restart or a worker reboot during a control-plane outage
# brings the worker up with no routes at all and 404s every application until
# the control plane returns. A file on disk survives both.
#
# Failure is always "keep what we have": a fetch that fails, times out or
# returns something that is not a routing document leaves the previous
# routes.yml untouched.

set -uo pipefail

ENV_FILE=/etc/rudder/traefik-config.env
TARGET=/etc/traefik/dynamic/routes.yml
# Staged outside the watched directory: Traefik reads every file in
# /etc/traefik/dynamic, and a half-written one would be parsed.
STAGE=/etc/rudder/routes.next

[ -r "$ENV_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$ENV_FILE"

[ -n "${CONFIG_ENDPOINT:-}" ] || exit 0
[ -n "${CONFIG_TOKEN:-}" ] || { echo "no config token; not fetching"; exit 1; }

cleanup() { rm -f "$STAGE"; }
trap cleanup EXIT

if ! curl -fsS --max-time 15 \
     -H "Authorization: Bearer ${CONFIG_TOKEN}" \
     -o "$STAGE" \
     "$CONFIG_ENDPOINT"; then
  echo "fetch failed — keeping the existing ${TARGET}"
  exit 1
fi

# Reject anything that is not a routing document before it can replace a
# working one. Traefik parses JSON through its YAML reader, so the file keeps
# the .yml extension the file provider expects.
#
# Exit code 2 from the check means "valid, but this worker has no routes".
HAS_ROUTES=1
if command -v python3 >/dev/null 2>&1; then
  python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d.get("http"), dict), "no http section"
routers = d["http"].get("routers")
assert routers is None or isinstance(routers, dict), "routers is not a map"
sys.exit(0 if routers else 2)
' "$STAGE" 2>/dev/null
  case $? in
    0) HAS_ROUTES=1 ;;
    2) HAS_ROUTES=0 ;;
    *) echo "response is not a routing document — keeping the existing ${TARGET}"; exit 1 ;;
  esac
elif ! grep -q '"routers"' "$STAGE"; then
  HAS_ROUTES=0
fi

# Traefik rejects a document whose sections are empty — "http cannot be a
# standalone element" — and rejects it for the whole file. A worker with no
# applications therefore gets no file at all rather than an empty one.
if [ "$HAS_ROUTES" -eq 0 ]; then
  if [ -f "$TARGET" ]; then
    rm -f "$TARGET"
    echo "no routes for this worker — removed ${TARGET}"
  fi
  exit 0
fi

if [ -f "$TARGET" ] && cmp -s "$STAGE" "$TARGET"; then
  exit 0
fi

chmod 644 "$STAGE"
mv -f "$STAGE" "$TARGET"
trap - EXIT
echo "routing configuration updated"
