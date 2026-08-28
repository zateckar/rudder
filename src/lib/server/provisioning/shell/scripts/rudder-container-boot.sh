#!/bin/bash
# Bring the worker's containers back after a reboot, and take them down
# gracefully before one.
#
# Podman has no daemon. A restart policy is enforced by the container's own
# conmon for as long as the host is up, and by nothing at all across a reboot —
# so every application Rudder deployed stayed down after a worker restart, while
# Traefik and CrowdSec came back only because they have systemd units of their
# own. Nothing reported it either: the containers still existed, so the worker
# looked provisioned and the applications looked deployed.
#
# Podman ships podman-restart.service for this, but it covers `always` alone.
# Rudder also offers `unless-stopped`, and Podman documents that policy as
# identical to `always` (it has no daemon-restart event to distinguish them), so
# both are started here.
set -uo pipefail

PODMAN=${PODMAN:-/usr/bin/podman}
# Matches the drain grace a deploy gives a superseded generation. Long enough
# for a database to flush, short enough that a reboot is not held hostage —
# TimeoutStopSec in the unit is set above this so systemd never SIGKILLs us
# mid-stop.
STOP_TIMEOUT=30
# Deliberately not `on-failure`: neither Podman's own unit nor Docker restarts
# those at boot, and a container that exits non-zero every time it starts would
# otherwise spin from the moment the worker comes up.
POLICIES=(always unless-stopped)

# Every container carrying one of the policies above, running or not.
ids_for_policy() {
  "$PODMAN" ps -a -q --filter "restart-policy=$1" 2>/dev/null || true
}

start_all() {
  local policy started=0
  for policy in "${POLICIES[@]}"; do
    # `start --all` skips containers that are already running, so this is safe
    # to re-run — `systemctl restart` on a live worker is a no-op.
    local ids
    ids=$(ids_for_policy "$policy")
    [ -n "$ids" ] || continue
    started=$((started + $(printf '%s\n' "$ids" | grep -c .)))
    # One `podman start` per container, not one for the batch: a single
    # container that cannot start (its image pruned, a volume gone) must not
    # take the rest of the worker's applications down with it.
    local id
    for id in $ids; do
      "$PODMAN" start "$id" >/dev/null 2>&1 \
        || echo "[rudder] failed to start $id (restart policy $policy)"
    done
  done
  echo "[rudder] boot: ${started} container(s) with a restart policy"
}

stop_all() {
  local policy ids
  for policy in "${POLICIES[@]}"; do
    # Only the running ones here: `podman stop` on an exited container is an
    # error, and shutdown is not the time to be parsing them.
    ids=$("$PODMAN" ps -q --filter "restart-policy=$policy" 2>/dev/null || true)
    [ -n "$ids" ] || continue
    # shellcheck disable=SC2086 -- word splitting is how the id list is passed.
    "$PODMAN" stop --time "$STOP_TIMEOUT" $ids >/dev/null 2>&1 || true
  done
}

case "${1:-start}" in
  start) start_all ;;
  stop) stop_all ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac

# Never fail the unit. A worker whose boot service is in a failed state stops
# being retried and, worse, reads as a broken host in `systemctl is-active` —
# the individual failures are on stdout above, where they name the container.
exit 0
