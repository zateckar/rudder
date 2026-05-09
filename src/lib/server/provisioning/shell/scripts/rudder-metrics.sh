#!/bin/bash
set -uo pipefail

# CPU: two /proc/stat samples 1s apart
read_cpu() { head -1 /proc/stat | awk '{print $2,$3,$4,$5,$6,$7,$8,$9}'; }
cpu1=$(read_cpu)
sleep 1
cpu2=$(read_cpu)

cpu_percent=$(echo "$cpu1" "$cpu2" | awk '{
  u1=$1+$2+$3+$6+$7+$8; i1=$4+$5
  u2=$9+$10+$11+$14+$15+$16; i2=$12+$13
  dt=(u2+i2)-(u1+i1)
  if(dt>0) printf "%.1f", 100*(u2-u1)/dt; else print "0"
}')
cpu_cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)

# Memory from /proc/meminfo
mem_total=$(awk '/^MemTotal:/{print $2*1024}' /proc/meminfo)
mem_free=$(awk '/^MemFree:/{print $2*1024}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/{print $2*1024}' /proc/meminfo)
mem_used=$((mem_total - mem_available))
if [ "$mem_total" -gt 0 ] 2>/dev/null; then
  mem_percent=$(awk -v used="$mem_used" -v total="$mem_total" 'BEGIN{printf "%.1f", 100*used/total}')
else
  mem_percent=0
fi

# Disk from df
read -r disk_total disk_used disk_available disk_percent_raw <<< "$(df -B1 / | awk 'NR==2{print $2,$3,$4,$5}')"
disk_percent=$(echo "$disk_percent_raw" | tr -d '%')

# Network from /proc/net/dev
read -r net_rx net_tx <<< "$(awk 'NR>2 && $1!~/lo:/{rx+=$2; tx+=$10} END{print rx, tx}' /proc/net/dev)"

cat > /tmp/rudder-metrics.json << JSONEOF
{"cpu_percent":${cpu_percent:-0},"cpu_cores":${cpu_cores:-1},"mem_total":${mem_total:-0},"mem_free":${mem_free:-0},"mem_available":${mem_available:-0},"mem_used":${mem_used:-0},"mem_percent":${mem_percent:-0},"disk_total":${disk_total:-0},"disk_used":${disk_used:-0},"disk_available":${disk_available:-0},"disk_percent":${disk_percent:-0},"net_rx_bytes":${net_rx:-0},"net_tx_bytes":${net_tx:-0}}
JSONEOF
chmod 644 /tmp/rudder-metrics.json
