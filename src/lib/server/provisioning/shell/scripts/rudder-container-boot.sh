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
SYSTEMCTL=${SYSTEMCTL:-systemctl}
RUNTIME_INTENT_DIR=${RUNTIME_INTENT_DIR:-/var/lib/rudder/runtime-intent}
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
  "$PODMAN" ps -a -q --no-trunc --filter "restart-policy=$1" 2>/dev/null || true
}

may_start() {
  local id=$1 marker managed stopped
  # Someone stopped it on this host — `podman stop`, Cockpit, Rudder — and has
  # not started it since. Podman clears the flag on every reboot, so this never
  # holds anything down at boot; it is what keeps provisioning, or a `systemctl
  # restart` of this unit, from overriding that person on a live worker before
  # the control plane has recorded the stop.
  stopped=$("$PODMAN" inspect --format '{{ .State.StoppedByUser }}' "$id" 2>/dev/null) || return 1
  [ "$stopped" != true ] || return 1
  marker="$RUNTIME_INTENT_DIR/$id"
  # Markers also cover adopted containers that cannot be relabelled in place.
  if [ -f "$marker" ]; then
    [ "$(cat "$marker" 2>/dev/null)" = running ]
    return
  fi
  managed=$("$PODMAN" inspect --format '{{ index .Config.Labels "rudder.managed" }}' "$id" 2>/dev/null) || return 1
  # Pending containers are never boot-eligible before explicit promotion writes
  # their marker. Preserve existing restart behavior for unrelated workloads.
  [ "$managed" != true ]
}

start_all() {
  local policy started=0
  for policy in "${POLICIES[@]}"; do
    # `start --all` skips containers that are already running, so this is safe
    # to re-run — `systemctl restart` on a live worker is a no-op.
    local ids
    ids=$(ids_for_policy "$policy")
    [ -n "$ids" ] || continue
    # One `podman start` per container, not one for the batch: a single
    # container that cannot start (its image pruned, a volume gone) must not
    # take the rest of the worker's applications down with it.
    local id
    for id in $ids; do
      may_start "$id" || continue
      started=$((started + 1))
      "$PODMAN" start "$id" >/dev/null 2>&1 \
        || echo "[rudder] failed to start $id (restart policy $policy)"
    done
  done
  echo "[rudder] boot: ${started} container(s) with a restart policy"
}

# True only while the host is shutting down or rebooting.
host_is_going_down() {
  [ "$("$SYSTEMCTL" is-system-running 2>/dev/null)" = stopping ] && return 0
  "$SYSTEMCTL" list-jobs --no-legend 2>/dev/null \
    | grep -qE '(^|[[:space:]])(shutdown|reboot|poweroff|halt|kexec)\.target([[:space:]]|$)'
}

stop_all() {
  local policy ids
  # This unit Requires= the Podman API socket, so systemd also stops it whenever
  # that socket stops — which provisioning does on every run. Stopping here then
  # took every application down until provisioning started the unit again, and
  # left each one marked as stopped by a user (`podman stop` sets the flag that
  # `may_start` and the control plane read as a person's decision). Applications
  # are taken down only on the way to a reboot, which clears that flag.
  if ! host_is_going_down; then
    echo "[rudder] stop: host is not shutting down; leaving containers running"
    return
  fi
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
