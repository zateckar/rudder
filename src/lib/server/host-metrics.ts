/**
 * Collect host-level system metrics (CPU, memory, disk, network) via SSH.
 * Uses /proc filesystem which is available on every Linux system — no extra dependencies.
 *
 * Usage:
 *   const stats = await getHostStats(sshConfig);
 *   // stats.cpuPercent, stats.memTotal, stats.diskTotal, stats.netRxBytes, etc.
 *
 * Also works with SSHPodmanConfig (same fields).
 */
import { executeSSHCommand, type SSHConnectionConfig } from './ssh';

export interface HostStats {
  cpuPercent: number | null;
  cpuCores: number | null;
  memTotal: number | null;
  memAvailable: number | null;
  memFree: number | null;
  memUsed: number | null;
  memPercent: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  diskAvailable: number | null;
  diskPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

/**
 * Single command that gathers all /proc stats and outputs them as key=value lines.
 * Two snapshots of /proc/stat are taken 1s apart to compute CPU utilization.
 */
const COLLECT_SCRIPT = `#!/bin/sh
# --- First /proc/stat snapshot ---
head -1 /proc/stat
sleep 1
# --- Second /proc/stat snapshot ---
head -1 /proc/stat
# --- Memory ---
cat /proc/meminfo
# --- Disk (root filesystem) ---
df -B1 /
# --- Network (aggregate all non-lo interfaces) ---
cat /proc/net/dev
`;

function parseCpuLine(line: string): { user: number; nice: number; system: number; idle: number; iowait: number; irq: number; softirq: number; steal: number } | null {
  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'cpu' || parts.length < 9) return null;
  return {
    user: parseInt(parts[1]) || 0,
    nice: parseInt(parts[2]) || 0,
    system: parseInt(parts[3]) || 0,
    idle: parseInt(parts[4]) || 0,
    iowait: parseInt(parts[5]) || 0,
    irq: parseInt(parts[6]) || 0,
    softirq: parseInt(parts[7]) || 0,
    steal: parseInt(parts[8]) || 0,
  };
}

function calculateCpuPercent(prev: ReturnType<typeof parseCpuLine>, curr: ReturnType<typeof parseCpuLine>): number | null {
  if (!prev || !curr) return null;
  const prevTotal = prev.user + prev.nice + prev.system + prev.idle + prev.iowait + prev.irq + prev.softirq + prev.steal;
  const currTotal = curr.user + curr.nice + curr.system + curr.idle + curr.iowait + curr.irq + curr.softirq + curr.steal;
  const totalDelta = currTotal - prevTotal;
  if (totalDelta <= 0) return 0;
  const idleDelta = curr.idle - prev.idle;
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 10000) / 100;
}

function countCpuCores(meminfoAndBelow: string): number | null {
  // Count "cpuN" lines in /proc/stat — but we only have /proc/meminfo here.
  // Instead, count processor entries from /proc/cpuinfo which we'll add to the script.
  // For now, return null and let the caller override.
  return null;
}

function parseMemInfo(block: string): { memTotal: number | null; memAvailable: number | null; memFree: number | null } {
  let memTotal: number | null = null;
  let memAvailable: number | null = null;
  let memFree: number | null = null;

  for (const line of block.split('\n')) {
    if (line.startsWith('MemTotal:')) {
      memTotal = (parseInt(line.split(/\s+/)[1]) || 0) * 1024; // kB -> bytes
    } else if (line.startsWith('MemAvailable:')) {
      memAvailable = (parseInt(line.split(/\s+/)[1]) || 0) * 1024;
    } else if (line.startsWith('MemFree:')) {
      memFree = (parseInt(line.split(/\s+/)[1]) || 0) * 1024;
    }
  }
  return { memTotal, memAvailable, memFree };
}

function parseDf(block: string): { diskTotal: number | null; diskUsed: number | null; diskAvailable: number | null; diskPercent: number | null } {
  // df -B1 / outputs:
  // Filesystem        1B-blocks         Used  Available Use% Mounted on
  // /dev/sda1  501323571200 123456789012 377866782188  25% /
  const lines = block.trim().split('\n');
  if (lines.length < 2) return { diskTotal: null, diskUsed: null, diskAvailable: null, diskPercent: null };

  // Find the data line (skip header, handle potential wrapping)
  let dataLine = '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('/')) {
      dataLine = lines[i].trim();
      break;
    }
  }
  if (!dataLine) return { diskTotal: null, diskUsed: null, diskAvailable: null, diskPercent: null };

  const parts = dataLine.split(/\s+/);
  // parts: [filesystem, total, used, available, percent, mount]
  if (parts.length < 5) return { diskTotal: null, diskUsed: null, diskAvailable: null, diskPercent: null };

  const diskTotal = parseInt(parts[1]) || null;
  const diskUsed = parseInt(parts[2]) || null;
  const diskAvailable = parseInt(parts[3]) || null;
  const percentStr = parts[4]?.replace('%', '');
  const diskPercent = percentStr ? parseFloat(percentStr) : null;

  return { diskTotal, diskUsed, diskAvailable, diskPercent };
}

function parseNetDev(block: string): { netRxBytes: number; netTxBytes: number } {
  let netRxBytes = 0;
  let netTxBytes = 0;

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Inter-') || trimmed.startsWith('face')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const iface = trimmed.substring(0, colonIdx).trim();
    // Skip loopback
    if (iface === 'lo') continue;

    const stats = trimmed.substring(colonIdx + 1).trim().split(/\s+/);
    if (stats.length >= 10) {
      netRxBytes += parseInt(stats[0]) || 0;   // rx_bytes
      netTxBytes += parseInt(stats[8]) || 0;   // tx_bytes
    }
  }

  return { netRxBytes, netTxBytes };
}

/**
 * Count CPU cores via /proc/stat (count "cpuN" lines)
 */
const COUNT_CORES_SCRIPT = `grep -c '^processor' /proc/cpuinfo || grep -c '^cpu[0-9]' /proc/stat`;

/**
 * Collect host stats from a remote worker via SSH.
 * Falls back gracefully — returns null for any metric that can't be read.
 */
export async function getHostStats(config: SSHConnectionConfig): Promise<HostStats> {
  const result: HostStats = {
    cpuPercent: null,
    cpuCores: null,
    memTotal: null,
    memAvailable: null,
    memFree: null,
    memUsed: null,
    memPercent: null,
    diskTotal: null,
    diskUsed: null,
    diskAvailable: null,
    diskPercent: null,
    netRxBytes: null,
    netTxBytes: null,
  };

  try {
    // Run the collection script via SSH
    const scriptResult = await executeSSHCommand(config, 'sh -s', COLLECT_SCRIPT);
    if (scriptResult.exitCode !== 0) {
      console.warn('[host-metrics] Collection script failed:', scriptResult.stderr);
      return result;
    }

    const output = scriptResult.stdout;
    const lines = output.split('\n');

    // Find the two cpu lines (first non-empty lines)
    let cpuLine1: string | null = null;
    let cpuLine2: string | null = null;
    let cpuCount = 0;

    for (const line of lines) {
      if (line.startsWith('cpu ')) {
        if (cpuCount === 0) {
          cpuLine1 = line;
        } else if (cpuCount === 1) {
          cpuLine2 = line;
        }
        cpuCount++;
      }
    }

    // Calculate CPU percent from delta
    if (cpuLine1 && cpuLine2) {
      const prev = parseCpuLine(cpuLine1);
      const curr = parseCpuLine(cpuLine2);
      result.cpuPercent = calculateCpuPercent(prev, curr);
    }

    // Parse memory
    const memStart = output.indexOf('MemTotal:');
    if (memStart !== -1) {
      // Find the section from MemTotal to roughly after MemFree/MemAvailable
      const memEnd = output.indexOf('\nFilesystem', memStart);
      const memBlock = memEnd !== -1 ? output.substring(memStart, memEnd) : output.substring(memStart, memStart + 2000);
      const mem = parseMemInfo(memBlock);
      result.memTotal = mem.memTotal;
      result.memAvailable = mem.memAvailable;
      result.memFree = mem.memFree;
      if (mem.memTotal && mem.memAvailable) {
        result.memUsed = mem.memTotal - mem.memAvailable;
        result.memPercent = Math.round((result.memUsed / mem.memTotal) * 10000) / 100;
      }
    }

    // Parse disk
    const dfStart = output.indexOf('Filesystem');
    if (dfStart !== -1) {
      const dfBlock = output.substring(dfStart);
      const disk = parseDf(dfBlock);
      result.diskTotal = disk.diskTotal;
      result.diskUsed = disk.diskUsed;
      result.diskAvailable = disk.diskAvailable;
      result.diskPercent = disk.diskPercent;
    }

    // Parse network
    const netStart = output.indexOf('Inter-|');
    if (netStart !== -1) {
      const netBlock = output.substring(netStart);
      const net = parseNetDev(netBlock);
      result.netRxBytes = net.netRxBytes;
      result.netTxBytes = net.netTxBytes;
    }
  } catch (e) {
    console.warn('[host-metrics] Failed to collect host stats:', e);
  }

  // Get CPU cores separately (quick command)
  try {
    const coresResult = await executeSSHCommand(config, COUNT_CORES_SCRIPT);
    if (coresResult.exitCode === 0) {
      const cores = parseInt(coresResult.stdout.trim());
      if (!isNaN(cores) && cores > 0) {
        result.cpuCores = cores;
      }
    }
  } catch {
    // Ignore — cpuCores stays null
  }

  return result;
}
