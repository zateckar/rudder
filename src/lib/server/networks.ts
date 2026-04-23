/**
 * Per-app and per-stack Podman network isolation.
 *
 * Each standalone application gets its own bridge network:  rudder-{appId[:8]}
 * Applications within a stack share a network:              rudder-s-{stackId[:8]}
 *
 * Traefik is connected to each app's network so it can resolve
 * containers by name and route traffic without host port mapping.
 */
import type { PodmanClient } from './podman';
import { executeSSHCommand, type SSHConnectionConfig } from './ssh';

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
 * Connect a container (and Traefik) to the app network.
 */
export async function joinNetwork(
  client: PodmanClient,
  containerId: string,
  networkName: string,
): Promise<void> {
  await client.connectContainerToNetwork(containerId, networkName);
}

/**
 * Connect Traefik to a network so it can route to containers on it.
 */
export async function connectTraefik(
  client: PodmanClient,
  networkName: string,
): Promise<void> {
  await client.connectContainerToNetwork('traefik', networkName);
}

/**
 * Run the Netavark stale-rule cleanup on a worker via SSH.
 *
 * This is a best-effort operation: errors are logged but never propagated so
 * that a cleanup failure never blocks a deployment or deletion.
 */
export async function purgeStaleNetavarkRules(
  sshConfig: SSHConnectionConfig,
): Promise<void> {
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
 * interfaces that Podman/Netavark may have left behind.
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
