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
# Last outcome, for the metrics collector to carry back to the control plane.
#
# A worker that cannot fetch is invisible from Rudder's side: the only signal is
# `config_fetched_at` staying null, which looks identical whether the timer was
# never installed, the host has no route to the control plane, or the token was
# rotated out from under it. Those need different fixes, and guessing between
# them from the control plane is not possible. So the worker reports what it
# actually saw, over the mTLS metrics endpoint it already has — deliberately not
# over the config endpoint, which is the thing that may be failing.
STATE=/var/lib/rudder/routing-fetch.json

# `detail` is one of a fixed set of tokens rather than free text: this file is
# spliced verbatim into the metrics JSON, so nothing here may need escaping.
record() {
  mkdir -p /var/lib/rudder 2>/dev/null
  cat > "$STATE" <<STATEEOF
{"routing_fetch_code":${1:-0},"routing_fetch_ok":${2:-0},"routing_fetch_at":$(date +%s),"routing_fetch_detail":"${3:-unknown}"}
STATEEOF
  chmod 644 "$STATE" 2>/dev/null
}

[ -r "$ENV_FILE" ] || exit 0
# shellcheck disable=SC1090
. "$ENV_FILE"

[ -n "${CONFIG_ENDPOINT:-}" ] || exit 0
[ -n "${CONFIG_TOKEN:-}" ] || { record 0 0 no-token; echo "no config token; not fetching"; exit 1; }

# Response headers are kept so a 401 can be attributed.
#
# Rudder answers an unauthenticated fetch with a bare 401 and no
# `WWW-Authenticate`. Anything fronting the control plane that wants its own
# credentials — basic auth, an OIDC middleware answering a non-HTML request —
# answers 401 *with* that header, and never reaches Rudder at all. The two are
# identical on the status line and have completely different fixes: reissue the
# worker's token, versus exempt the routing endpoint at the proxy.
HEADERS=$(mktemp)
# Declared before the trap is installed: `set -u` would make the handler itself
# fail on an unset variable if anything exited in between.
CURLRC=""
cleanup() { rm -f "$STAGE" "$HEADERS" ${CURLRC:+"$CURLRC"}; }
trap cleanup EXIT

# Two layers of authentication, one Authorization header.
#
# Where the control plane is published behind a proxy that demands HTTP Basic,
# that proxy has to be satisfied first — it answers 401 and the request never
# reaches Rudder otherwise. So `Authorization` carries Basic and this worker's
# own credential moves to `X-Rudder-Config-Token`, which the config endpoint
# accepts as an equivalent. With no Basic credentials configured the header is
# left as Bearer, exactly as before.
#
# The Basic credentials go through a curl config file, not `--user`: process
# arguments are world-readable through /proc for as long as curl runs, and this
# one is a password. The file is created 600 and removed on exit.
#
# Values are escaped for curl's config syntax, which is double-quoted with
# backslash escapes — done with parameter expansion so no other process sees the
# password on a command line either.
if [ -n "${CONFIG_BASIC_USER:-}" ]; then
  CURLRC=$(mktemp)
  chmod 600 "$CURLRC"
  _u=${CONFIG_BASIC_USER//\\/\\\\}; _u=${_u//\"/\\\"}
  _p=${CONFIG_BASIC_PASS:-};        _p=${_p//\\/\\\\}; _p=${_p//\"/\\\"}
  printf 'user = "%s:%s"\n' "$_u" "$_p" > "$CURLRC"
  unset _u _p
  AUTH_ARGS=(-K "$CURLRC" -H "X-Rudder-Config-Token: ${CONFIG_TOKEN}")
else
  AUTH_ARGS=(-H "Authorization: Bearer ${CONFIG_TOKEN}")
fi

HTTP_CODE=$(curl -fsS --max-time 15 \
     "${AUTH_ARGS[@]}" \
     -o "$STAGE" \
     -D "$HEADERS" \
     -w '%{http_code}' \
     "$CONFIG_ENDPOINT")
CURL_RC=$?
# `-f` suppresses the body on an error status but `-w` still reports the code;
# a transport failure (DNS, refused, TLS, timeout) reports 000, which is why
# this is forced to a number rather than passed through.
#
# The base-10 coercion is not cosmetic: this value is interpolated into a JSON
# document that rudder-metrics.sh splices in verbatim, and JSON rejects the
# leading zeros in `000`. One malformed number there would fail the parse of the
# whole metrics payload, so a worker that lost its route to the control plane
# would also stop reporting CPU, memory and disk.
case "$HTTP_CODE" in
  ''|*[!0-9]*) HTTP_CODE=0 ;;
  *) HTTP_CODE=$((10#$HTTP_CODE)) ;;
esac

if [ "$CURL_RC" -ne 0 ]; then
  if [ "$HTTP_CODE" -eq 0 ]; then
    record 0 0 transport
    echo "fetch failed — could not reach ${CONFIG_ENDPOINT} (keeping the existing ${TARGET})"
  elif grep -qi '^www-authenticate:' "$HEADERS"; then
    record "$HTTP_CODE" 0 proxy-auth
    echo "fetch failed — ${HTTP_CODE} from something in front of the control plane, which is asking for its own"
    echo "credentials ($(grep -i '^www-authenticate:' "$HEADERS" | head -1 | tr -d '\r')). The request never"
    echo "reached Rudder. The routing endpoint must be reachable with only its bearer token."
  else
    record "$HTTP_CODE" 0 http
    echo "fetch failed — control plane answered ${HTTP_CODE} (keeping the existing ${TARGET})"
  fi
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
    *) record "$HTTP_CODE" 0 not-a-document
       echo "response is not a routing document — keeping the existing ${TARGET}"; exit 1 ;;
  esac
elif ! grep -q '"routers"' "$STAGE"; then
  HAS_ROUTES=0
fi

# Traefik rejects a document whose sections are empty — "http cannot be a
# standalone element" — and rejects it for the whole file. A worker with no
# applications therefore gets no file at all rather than an empty one.
if [ "$HAS_ROUTES" -eq 0 ]; then
  # A successful fetch: the control plane answered and this worker genuinely has
  # nothing to route. Recorded as ok so it is not reported as a failure.
  record "$HTTP_CODE" 1 no-routes
  if [ -f "$TARGET" ]; then
    rm -f "$TARGET"
    echo "no routes for this worker — removed ${TARGET}"
  fi
  exit 0
fi

record "$HTTP_CODE" 1 ok

if [ -f "$TARGET" ] && cmp -s "$STAGE" "$TARGET"; then
  exit 0
fi

chmod 644 "$STAGE"
mv -f "$STAGE" "$TARGET"
trap - EXIT
echo "routing configuration updated"
