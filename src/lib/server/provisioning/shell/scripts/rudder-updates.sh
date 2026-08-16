#!/bin/bash
# Cache this host's patch state for the metrics collector.
#
# `apt-get -s upgrade` takes seconds and holds a lock; rudder-metrics.sh runs
# on a short timer and must stay cheap, so the expensive part happens here on a
# daily timer and the collector only reads the result. A count that is a day
# stale is fine — pending updates do not appear minute to minute — whereas a
# metrics collector that blocks on the apt lock is not.
#
# Output is a JSON fragment consumed verbatim by rudder-metrics.sh. Nothing is
# written unless the whole scan succeeded: a partial file would report "0
# updates pending" for a host that simply could not be scanned, which reads as
# healthy and is the one wrong answer here.

set -uo pipefail

CACHE=/var/lib/rudder/updates.json
STAGE=/var/lib/rudder/.updates.json.next

mkdir -p /var/lib/rudder

cleanup() { rm -f "$STAGE"; }
trap cleanup EXIT

# `apt-get -s upgrade` needs current lists to mean anything, but a failed
# refresh is not fatal — yesterday's lists still give a usable count.
apt-get update -q >/dev/null 2>&1 || true

SIM=$(apt-get -s upgrade 2>/dev/null)
if [ -z "$SIM" ]; then
  echo "apt simulation produced no output — leaving the previous cache in place"
  exit 1
fi

PENDING=$(printf '%s\n' "$SIM" | grep -c '^Inst ' || true)

# Security updates are the ones whose candidate comes from a *-security pocket.
# apt-get's simulation prints the origin in parentheses on the Inst line.
SECURITY=$(printf '%s\n' "$SIM" | grep '^Inst ' | grep -ci 'security' || true)

REBOOT=0
[ -f /var/run/reboot-required ] && REBOOT=1

cat > "$STAGE" << JSONEOF
{"updates_pending":${PENDING:-0},"updates_security":${SECURITY:-0},"reboot_required":${REBOOT}}
JSONEOF

chmod 644 "$STAGE"
mv -f "$STAGE" "$CACHE"
trap - EXIT
echo "patch state: ${PENDING:-0} pending, ${SECURITY:-0} security, reboot_required=${REBOOT}"
