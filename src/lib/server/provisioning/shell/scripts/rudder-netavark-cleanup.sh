#!/bin/bash
set -uo pipefail
sudo iptables -t nat -L NETAVARK-HOSTPORT-DNAT -n &>/dev/null || exit 0
declare -A stale
while IFS= read -r line; do
  linenum=$(printf '%s' "$line" | awk '{print $1}')
  [[ "$linenum" =~ ^[0-9]+$ ]] || continue
  chain=$(printf '%s' "$line" | grep -oE 'NETAVARK-DN-[A-F0-9]+')
  [[ -z "$chain" ]] && continue
  cid=$(printf '%s' "$line" | sed 's/.*id: //' | awk '{print $1}' | cut -c1-12)
  [[ -z "$cid" ]] && continue
  sudo podman inspect "$cid" &>/dev/null && continue
  stale["$chain"]="$linenum"
done < <(sudo iptables -t nat -L NETAVARK-HOSTPORT-DNAT -n --line-numbers 2>/dev/null | tail -n +3)
[[ ${#stale[@]} -eq 0 ]] && exit 0
echo "[rudder] Purging ${#stale[@]} stale Netavark DNAT rule(s)..."
mapfile -t sorted_lines < <(printf '%s\n' "${stale[@]}" | sort -rn)
for linenum in "${sorted_lines[@]}"; do
  sudo iptables -t nat -D NETAVARK-HOSTPORT-DNAT "$linenum" 2>/dev/null || true
done
for chain in "${!stale[@]}"; do
  sudo iptables -t nat -F "$chain" 2>/dev/null || true
  sudo iptables -t nat -X "$chain" 2>/dev/null || true
  echo "[rudder] Removed stale chain $chain"
done
active_ifaces=$(sudo podman network ls -q 2>/dev/null | \
  xargs -r -I{} sudo podman network inspect {} --format '{{.NetworkInterface}}' 2>/dev/null || true)
while IFS= read -r iface; do
  [[ -z "$iface" ]] && continue
  ip link show "$iface" 2>/dev/null | grep -q 'state DOWN' || continue
  printf '%s\n' "$active_ifaces" | grep -qxF "$iface" && continue
  sudo ip link delete "$iface" 2>/dev/null || true
  echo "[rudder] Removed orphaned bridge interface $iface"
done < <(ip -o link show 2>/dev/null | awk -F'[ :@]+' '/podman[0-9]+/{print $2}')
