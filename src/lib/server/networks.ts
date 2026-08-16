/**
 * Per-app and per-stack Podman network isolation.
 *
 * Each standalone application gets its own bridge network:  rudder-{appId[:8]}
 * Applications within a stack share a network:              rudder-s-{stackId[:8]}
 *
 * The network exists so containers can reach each other by service name.
 * Traefik is *not* on it: it runs with host networking and proxies to each
 * container's 127.0.0.1 host port, so it needs no bridge membership — and
 * could not have one, since Podman refuses to attach a host-networked
 * container to a bridge network.
 *
 * Containers are attached at creation time via `NetworkMode`, so there is no
 * separate join step.
 */
import type { PodmanClient } from './podman';
import { routerName, toDnsLabel } from './domains';
import { executeSSHCommand, type SSHConnectionConfig } from './ssh';

// ── Network aliases ──────────────────────────────────────────────────────────

/**
 * The label a container advertises itself under, so a sibling can find it.
 *
 * Every container gets one, on every deployment format. Without it the only
 * name a sibling can use is the generated container name — which carries the
 * application id and, since blue/green, a `-g<N>` generation suffix that
 * changes on every deploy.
 */
export const ALIAS_LABEL = 'rudder.alias';

/**
 * DNS names a container answers to on its network.
 *
 * Two of them, and both matter:
 *
 * - the **bare** name — `db`, `web`, the compose service or Kubernetes
 *   container name. This is what a manifest written for Docker Compose or for
 *   Kubernetes already uses, so it has to work.
 * - the **qualified** name — `<app>-<key>`. A stack shares one network, so two
 *   applications in it may each define a `db`. The bare name then resolves to
 *   whichever container Podman's DNS answers with; the qualified one is
 *   unambiguous.
 *
 * For a container whose key is the application itself (a single-container app)
 * the two collapse into one name, which is returned alone.
 */
export function networkAliases(appName: string, key: string): string[] {
  const qualified = routerName(appName, key);
  const bare = toDnsLabel(key);
  if (!bare || bare === qualified) return [qualified];
  return [bare, qualified];
}

/**
 * Refuse an application whose containers would claim the same alias.
 *
 * Aliases are DNS labels, so `my_db` and `my-db` are the same name even though
 * the manifest distinguishes them. Podman accepts the duplicate and resolves it
 * to one of the two arbitrarily, which is exactly the sort of failure that only
 * shows up under load, so it is rejected at parse time instead.
 */
export function assertDistinctAliases(appName: string, keys: readonly string[]): void {
  const claimedBy = new Map<string, string>();
  for (const key of keys) {
    const alias = toDnsLabel(key) || toDnsLabel(appName);
    const previous = claimedBy.get(alias);
    if (previous !== undefined) {
      throw new Error(
        previous === key
          ? `Two containers are both named "${key}". Names must be unique within an ` +
            `application: they become network aliases, and one name cannot resolve to two containers.`
          : `Containers "${previous}" and "${key}" both resolve to the network alias "${alias}". ` +
            `Rename one — aliases are DNS labels, so names differing only in case or punctuation collide.`,
      );
    }
    claimedBy.set(alias, key);
  }
}

/**
 * Bash script that purges stale Netavark iptables DNAT rules for containers
 * that no longer exist, along with their orphaned chains and bridge interfaces.
 *
 * Background: when Podman removes a network via its REST API, Netavark
 * occasionally fails to clean up iptables chains and kernel bridge interfaces.
 * Stale DNAT rules are inserted before live ones in NETAVARK-HOSTPORT-DNAT,
 * so they win the first-match evaluation and redirect traffic to a dead IP,
 * producing HTTP 502 on the external hostname even though the container is
 * running and healthy internally.
 */
const NETAVARK_CLEANUP_SCRIPT = `#!/bin/bash
set -uo pipefail

# Bail early if this worker does not use Netavark iptables integration
sudo iptables -t nat -L NETAVARK-HOSTPORT-DNAT -n &>/dev/null || exit 0

declare -A stale   # chain_name -> line_number

# Scan every rule in NETAVARK-HOSTPORT-DNAT.
# A rule is stale when its embedded container ID is unknown to Podman.
while IFS= read -r line; do
  linenum=$(printf '%s' "$line" | awk '{print $1}')
  [[ "$linenum" =~ ^[0-9]+$ ]] || continue

  chain=$(printf '%s' "$line" | grep -oE 'NETAVARK-DN-[A-F0-9]+')
  [[ -z "$chain" ]] && continue

  # Extract first 12 chars of the container ID embedded in the iptables comment.
  # Comment format: /* dnat name: <network> id: <container_id> */
  cid=$(printf '%s' "$line" | sed 's/.*id: //' | awk '{print $1}' | cut -c1-12)
  [[ -z "$cid" ]] && continue

  # If the container still exists, the rule is live — skip it.
  sudo podman inspect "$cid" &>/dev/null && continue

  stale["$chain"]="$linenum"
done < <(sudo iptables -t nat -L NETAVARK-HOSTPORT-DNAT -n --line-numbers 2>/dev/null | tail -n +3)

[[ \${#stale[@]} -eq 0 ]] && exit 0

echo "[rudder] Purging \${#stale[@]} stale Netavark DNAT rule(s)..."

# Delete rules from the highest line number downward to prevent index shifting.
mapfile -t sorted_lines < <(printf '%s\n' "\${stale[@]}" | sort -rn)
for linenum in "\${sorted_lines[@]}"; do
  sudo iptables -t nat -D NETAVARK-HOSTPORT-DNAT "$linenum" 2>/dev/null || true
done

# Flush internal rules then delete each orphaned chain.
for chain in "\${!stale[@]}"; do
  sudo iptables -t nat -F "$chain" 2>/dev/null || true
  sudo iptables -t nat -X "$chain" 2>/dev/null || true
  echo "[rudder] Removed stale chain $chain"
done

# Remove linkdown Podman bridge interfaces not associated with any active network.
active_ifaces=$(sudo podman network ls -q 2>/dev/null | \\
  xargs -r -I{} sudo podman network inspect {} --format '{{.NetworkInterface}}' \\
  2>/dev/null || true)

while IFS= read -r iface; do
  [[ -z "$iface" ]] && continue
  ip link show "$iface" 2>/dev/null | grep -q 'state DOWN' || continue
  printf '%s\n' "$active_ifaces" | grep -qxF "$iface" && continue
  sudo ip link delete "$iface" 2>/dev/null || true
  echo "[rudder] Removed orphaned bridge interface $iface"
done < <(ip -o link show 2>/dev/null | awk -F'[ :@]+' '/podman[0-9]+/{print $2}')
`;

/** Generate a deterministic, short network name for a standalone app. */
export function appNetworkName(appId: string): string {
  return `rudder-${appId.slice(0, 8)}`;
}

/** Generate a deterministic, short network name for a stack. */
export function stackNetworkName(stackId: string): string {
  return `rudder-s-${stackId.slice(0, 8)}`;
}

/**
 * Ensure the correct network exists and return its name.
 * Stack apps share a network; standalone apps get their own.
 */
export async function ensureAppNetwork(
  client: PodmanClient,
  appId: string,
  stackId?: string | null,
): Promise<string> {
  const name = stackId ? stackNetworkName(stackId) : appNetworkName(appId);
  await client.createNetwork(name);
  return name;
}

/**
 * Run the Netavark stale-rule cleanup on a worker via SSH.
 *
 * NOTE: As of the security hardening, this cleanup is also installed
 * as a systemd timer on each worker during provisioning. This SSH-based call
 * is kept as a supplementary trigger for immediate cleanup after network removal,
 * but it is entirely optional — if no sshConfig is provided, the timer will
 * handle cleanup within 5 minutes.
 *
 * This is a best-effort operation: errors are logged but never propagated so
 * that a cleanup failure never blocks a deployment or deletion.
 */
export async function purgeStaleNetavarkRules(
  sshConfig: SSHConnectionConfig | null | undefined,
): Promise<void> {
  if (!sshConfig) {
    // No SSH config available — rely on the systemd timer on the worker
    return;
  }
  try {
    const result = await executeSSHCommand(sshConfig, 'sudo bash', NETAVARK_CLEANUP_SCRIPT);
    if (result.stdout.trim()) {
      console.log('[netavark-cleanup]', result.stdout.trim());
    }
    if (result.exitCode !== 0 && result.stderr.trim()) {
      console.warn('[netavark-cleanup] script exited with', result.exitCode, result.stderr.trim());
    }
  } catch (e: any) {
    console.warn('[netavark-cleanup] SSH cleanup failed (non-fatal):', e.message);
  }
}

/**
 * Disconnect all containers from a network, then remove the network.
 * For standalone apps the network is removed entirely.
 * For stack apps the network is only removed when the last app leaves.
 *
 * When `sshConfig` is provided, a Netavark iptables cleanup is performed after
 * the network is removed to purge any stale DNAT rules and orphaned bridge
 * interfaces that Podman/Netavark may have left behind. If not provided,
 * the systemd timer on the worker handles this automatically.
 */
export async function teardownAppNetwork(
  client: PodmanClient,
  appId: string,
  stackId: string | null | undefined,
  containerIds: string[],
  sshConfig?: SSHConnectionConfig | null,
): Promise<void> {
  const name = stackId ? stackNetworkName(stackId) : appNetworkName(appId);

  for (const cid of containerIds) {
    await client.disconnectContainerFromNetwork(cid, name);
  }

  // Only remove standalone app networks; stack networks persist while any app uses them
  if (!stackId) {
    await client.removeNetwork(name);
    // After the network is gone, sweep for orphaned Netavark iptables state.
    // This is fire-and-forget: a cleanup failure must never abort the deployment.
    if (sshConfig) {
      await purgeStaleNetavarkRules(sshConfig);
    }
  }
}

/**
 * Remove a stack network when the last app is being removed.
 * Call this after all containers have been disconnected.
 */
export async function removeStackNetwork(
  client: PodmanClient,
  stackId: string,
): Promise<void> {
  await client.removeNetwork(stackNetworkName(stackId));
}
