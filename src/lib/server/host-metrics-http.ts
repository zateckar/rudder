/**
 * Collect host stats from a worker via its HTTP metrics endpoint.
 *
 * The metrics endpoint is installed during provisioning as a lightweight
 * systemd service that periodically writes host stats to a JSON file,
 * served by Traefik with mTLS authentication.
 *
 * This replaces the SSH-based host metrics collection (host-metrics.ts).
 */
import type { HostStats } from './host-metrics';
import https from 'https';
import http from 'http';

interface MetricsWorker {
  podmanApiUrl: string;
  podmanCaCert: string | null;
  podmanClientCert: string | null;
  podmanClientKey: string | null;
  baseDomain: string | null;
  hostname: string;
}

function resolveCert(value: string): string | Buffer {
  // If it looks like a file path, read it; otherwise treat as PEM content
  if (value.startsWith('/') || value.startsWith('.')) {
    return require('fs').readFileSync(value);
  }
  return value;
}

/**
 * Fetch host stats via the HTTP metrics endpoint.
 * Returns null if the worker doesn't have a metrics URL or the request fails.
 */
export async function getHostStatsHttp(worker: MetricsWorker): Promise<HostStats | null> {
  const metricsUrl = worker.baseDomain
    ? `https://metrics.${worker.baseDomain}/`
    : null;

  if (!metricsUrl) return null;

  try {
    const agentOptions: https.AgentOptions = {
      rejectUnauthorized: false,
    };

    if (worker.podmanCaCert) agentOptions.ca = resolveCert(worker.podmanCaCert);
    if (worker.podmanClientCert) agentOptions.cert = resolveCert(worker.podmanClientCert);
    if (worker.podmanClientKey) agentOptions.key = resolveCert(worker.podmanClientKey);

    const agent = new https.Agent(agentOptions);

    const response = await new Promise<string>((resolve, reject) => {
      const urlObj = new URL(metricsUrl);
      const reqModule = urlObj.protocol === 'https:' ? https : http;

      const req = reqModule.get(metricsUrl, { agent, timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) {
          // Silently reject on 404 - metrics endpoint may not be ready yet on newly provisioned workers
          reject(new Error(`${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });

    const stats = JSON.parse(response);

    // Map the metrics service JSON to our HostStats shape
    return {
      cpuPercent: stats.cpu_percent ?? null,
      cpuCores: stats.cpu_cores ?? null,
      memTotal: stats.mem_total ?? null,
      memAvailable: stats.mem_available ?? null,
      memFree: stats.mem_free ?? null,
      memUsed: stats.mem_used ?? null,
      memPercent: stats.mem_percent ?? null,
      diskTotal: stats.disk_total ?? null,
      diskUsed: stats.disk_used ?? null,
      diskAvailable: stats.disk_available ?? null,
      diskPercent: stats.disk_percent ?? null,
      netRxBytes: stats.net_rx_bytes ?? null,
      netTxBytes: stats.net_tx_bytes ?? null,
    };
  } catch (e: any) {
    // Suppress expected startup errors (404, 502) - these are normal on newly provisioned workers
    // 404 = Traefik route not configured yet
    // 502 = Traefik is up but backend service (localhost:9100) not ready
    const expectedErrors = ['404', '502', 'ECONNREFUSED', 'ENOTFOUND', 'timeout'];
    const isExpectedError = expectedErrors.some(err => e.message?.includes(err));

    if (!isExpectedError) {
      console.warn(`[host-metrics-http] Failed to fetch metrics from ${metricsUrl}:`, e);
    }
    return null;
  }
}
