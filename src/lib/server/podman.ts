import https from 'https';
import http from 'http';
import tls from 'tls';
import { readFileSync, existsSync } from 'fs';
import { URL } from 'url';
import { executeSSHCommand, testSSHConnection, type SSHConnectionConfig } from './ssh';
import WebSocket from 'ws';

/**
 * Resolves a cert value that may be either PEM content (starts with "-----")
 * or a filesystem path. DB-stored certs are always PEM strings.
 */
function resolveCert(value: string): string | Buffer {
  if (value.trim().startsWith('-----')) {
    return Buffer.from(value);   // inline PEM content
  }
  // A caller that forgot to decryptField() lands here with `iv:tag:ciphertext`,
  // which used to be handed to readFileSync and surfaced as a baffling
  // "ENOENT: no such file or directory, open '0478930...'". Say what actually
  // went wrong instead.
  if (!value.startsWith('/') && !value.startsWith('.') && !/^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error(
      'Podman client credential is neither PEM content nor a file path. ' +
        'Stored credentials are encrypted at rest — build the client with getRestPodmanClient(), ' +
        'which decrypts them.',
    );
  }
  return readFileSync(value);    // file path (legacy/dev usage)
}

/**
 * A refusal from Podman, with the status it refused under.
 *
 * Podman answers "you cannot do that" precisely — 409 for an image still in use
 * by a container, 404 for one that is not there. Flattening every one of those
 * into a thrown string meant routes reported them as HTTP 500, so a rule the
 * user had broken read as the control plane falling over, and the raw JSON body
 * ended up in front of them because nothing had pulled the sentence out of it.
 *
 * The `message` keeps its historical text so existing string matching still
 * works; `status` and `detail` are what new code should read.
 */
export class PodmanApiError extends Error {
  constructor(
    readonly status: number,
    /** Podman's own sentence, extracted from the JSON body when there is one. */
    readonly detail: string,
    body: string,
  ) {
    super(`Podman API error: ${status} - ${body}`);
    this.name = 'PodmanApiError';
  }

  /** Build one from a raw response body, digging out the human-readable part. */
  static fromResponse(status: number, body: string): PodmanApiError {
    let detail = body.trim();
    try {
      const parsed = JSON.parse(body);
      const found = parsed?.message ?? parsed?.cause ?? parsed?.Err ?? parsed?.error;
      if (typeof found === 'string' && found.trim()) detail = found.trim();
    } catch {
      // Not JSON — the body is the message, such as it is.
    }
    return new PodmanApiError(status, detail || `Podman returned HTTP ${status}`, body);
  }
}

/**
 * Split Podman's multiplexed exec output into the two streams.
 *
 * Without a TTY the daemon prefixes every write with an 8-byte header: byte 0
 * is the stream (1 = stdout, 2 = stderr) and bytes 4–7 are the payload length,
 * big-endian. A trailing partial frame is kept rather than dropped — it is
 * output that was written, just cut short.
 */
export function demultiplexExecStream(raw: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= raw.length) {
    const streamType = raw[offset];
    const size = raw.readUInt32BE(offset + 4);

    // Not a frame header: some Podman versions answer a TTY-less exec with a
    // plain body. Treat the remainder as stdout rather than losing it.
    if (streamType !== 1 && streamType !== 2) {
      out.push(raw.subarray(offset));
      offset = raw.length;
      break;
    }

    const end = Math.min(offset + 8 + size, raw.length);
    (streamType === 2 ? err : out).push(raw.subarray(offset + 8, end));
    offset = offset + 8 + size;
  }

  if (offset < raw.length) out.push(raw.subarray(offset));

  return {
    stdout: Buffer.concat(out).toString('utf-8'),
    stderr: Buffer.concat(err).toString('utf-8'),
  };
}

export interface PodmanConfig {
  apiUrl: string;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  /**
   * Skip verification of the worker's *server* certificate.
   *
   * Only for a worker whose Traefik is still serving its self-signed default
   * certificate — before ACME has issued one — and only because the operator
   * asked for it. See `getRestPodmanClient`, which is the only caller that sets
   * it, from ALLOW_INSECURE_PODMAN.
   */
  insecureSkipVerify?: boolean;
}

export interface SSHPodmanConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export interface Container {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  State: string;
  Status: string;
  Ports: Array<{
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: string;
  }>;
  Labels: Record<string, string>;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Labels: Record<string, string>;
    Env?: string[];
    Cmd?: string[];
    Entrypoint?: string[];
    WorkingDir?: string;
  };
  State: {
    Status: string;
    Running: boolean;
    Pid: number;
    ExitCode: number;
    /**
     * Present only when the image or the create call defined a health check.
     * `starting` until the first probe succeeds or the retries run out.
     */
    Health?: {
      Status: 'starting' | 'healthy' | 'unhealthy' | string;
      FailingStreak?: number;
    };
  };
  /**
   * How many times Podman has restarted this container. A blue/green deploy
   * watches it: with `restart: always`, a container that crashes is back up by
   * the next poll, so "is it running" alone cannot tell a healthy start from a
   * crash loop.
   */
  RestartCount?: number;
  HostConfig: {
    RestartPolicy?: {
      Name: string;
    };
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort: string }>>;
    Binds?: string[];
    Memory?: number;
    CpuPeriod?: number;
    CpuQuota?: number;
  };
  NetworkSettings: {
    IPAddress: string;
  };
}

export interface Image {
  Id: string;
  RepoTags: string[];
  Size: number;
}

export interface ContainerStats {
  cpu_stats: {
    cpu_usage: {
      total_usage: number;
      usage_in_kernelmode: number;
      usage_in_usermode: number;
      percpu_usage?: number[];
    };
    system_cpu_usage: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
  };
  memory_stats: {
    usage: number;
    limit: number;
    stats?: Record<string, number>;
  };
  networks?: Record<string, {
    rx_bytes: number;
    tx_bytes: number;
    rx_packets: number;
    tx_packets: number;
  }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{
      major: number;
      minor: number;
      op: string;
      value: number;
    }>;
  };
}

export interface ImageInspect {
  Id: string;
  RepoTags: string[];
  RepoDigests: string[];
  Created: string;
  Size: number;
  VirtualSize: number;
  Architecture: string;
  Os: string;
  Config: {
    Env?: string[];
    ExposedPorts?: Record<string, object>;
    Labels?: Record<string, string>;
    Cmd?: string[];
    Entrypoint?: string[];
    WorkingDir?: string;
  };
}

/**
 * A live exec session: writes are stdin, callbacks are output.
 *
 * Deliberately not an EventEmitter or a Duplex — the two consumers (the UI
 * terminal and `kubectl exec`) each need exactly these five operations, and a
 * narrow surface is what lets the TTY and multiplexed cases hide behind one
 * shape.
 */
export interface ExecStream {
  execId: string;
  /**
   * False when the stream was opened without a hijack, which happens when the
   * mTLS proxy in front of the Podman API refuses the upgrade. Output still
   * flows; `write` is a no-op. Callers that need an interactive session must
   * check this and tell the user, rather than swallowing their keystrokes.
   */
  stdinAvailable: boolean;
  write: (data: Buffer | string) => void;
  close: () => void;
  onStdout: (fn: (data: Buffer) => void) => void;
  /** Never called in TTY mode: the pty merges the streams before we see them. */
  onStderr: (fn: (data: Buffer) => void) => void;
  onEnd: (fn: () => void) => void;
  /** Exit status, once the command has finished. */
  inspect: () => Promise<{ exitCode: number; running: boolean }>;
}

export interface ImageHistoryEntry {
  Id: string;
  Created: number;
  CreatedBy: string;
  Tags: string[];
  Size: number;
  Comment: string;
}

export class PodmanClient {
  private baseUrl: string;
  private httpsAgent: https.Agent | null = null;
  private httpAgent: http.Agent | null = null;

  constructor(config: PodmanConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    
    const isHttps = this.baseUrl.startsWith('https://');
    
    if (isHttps) {
      const httpsAgentOptions: https.AgentOptions = {
        keepAlive: true,
      };

      if (config.clientCert && config.clientKey) {
        httpsAgentOptions.cert = resolveCert(config.clientCert);
        httpsAgentOptions.key = resolveCert(config.clientKey);
      }

      // Trust the public roots *and* the worker's CA.
      //
      // Node's `ca` replaces the default store rather than adding to it, and the
      // CA provisioning generates signs only the control plane's client
      // certificate — the server side is Traefik with an ACME certificate. So
      // pinning `ca` to the worker CA alone would reject every real worker,
      // which is why this previously turned verification off instead. Trusting
      // both means an ACME certificate verifies against the public roots and a
      // Rudder-issued one against the private CA.
      httpsAgentOptions.ca = config.caCert
        ? [...tls.rootCertificates, resolveCert(config.caCert).toString()]
        : undefined;

      // Presenting a client certificate authenticates *us* to the worker; it
      // says nothing about who answered. Without this the pinned CA was
      // decorative: anything on the path to the worker could terminate the
      // connection and drive its root-equivalent Podman API.
      httpsAgentOptions.rejectUnauthorized = !config.insecureSkipVerify;

      this.httpsAgent = new https.Agent(httpsAgentOptions);
    } else {
      this.httpAgent = new http.Agent({ keepAlive: true });
    }
  }

  private getAgent(url: string): http.Agent | https.Agent | undefined {
    if (url.startsWith('https://')) {
      return this.httpsAgent ?? undefined;
    }
    return this.httpAgent ?? undefined;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    // Use Node.js https/http module directly to properly support custom agents
    // (global fetch in Node.js 18+ does not support the 'agent' option)
    const nodeUrl = new URL(url);
    const agent = this.getAgent(url);
    const method = (options.method as string) || 'GET';
    const body = options.body as string | undefined;

    return new Promise<T>((resolve, reject) => {
      const reqModule = nodeUrl.protocol === 'https:' ? https : http;
      const reqOptions = {
        hostname: nodeUrl.hostname,
        port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
        path: nodeUrl.pathname + nodeUrl.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers as Record<string, string> || {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        agent,
        timeout: 30_000, // 30 s — prevents hung requests from blocking the metrics scheduler
      };

      const req = reqModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(PodmanApiError.fromResponse(res.statusCode, data));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            const firstLine = data.split('\n')[0];
            if (firstLine) {
              try {
                resolve(JSON.parse(firstLine) as T);
                return;
              } catch {}
            }
            resolve(data as unknown as T);
          }
        });
      });

      const absoluteTimeout = setTimeout(() => {
        req.destroy(new Error(`Podman API request absolute timeout: ${method} ${path}`));
      }, 30_000);

      req.on('close', () => clearTimeout(absoluteTimeout));

      req.on('timeout', () => {
        req.destroy(new Error(`Podman API request timed out: ${method} ${path}`));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Send a non-JSON body (a tar archive) and ignore the response body.
   *
   * `request` assumes a JSON request and response; secret material goes over
   * this path, so it is a separate method rather than a widened one — nothing
   * here ever stringifies the payload into a log line.
   */
  private async requestBinary(
    path: string,
    method: string,
    body: Buffer,
    contentType = 'application/x-tar',
  ): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const nodeUrl = new URL(url);
    const agent = this.getAgent(url);

    return new Promise<void>((resolve, reject) => {
      const reqModule = nodeUrl.protocol === 'https:' ? https : http;
      const req = reqModule.request(
        {
          hostname: nodeUrl.hostname,
          port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
          path: nodeUrl.pathname + nodeUrl.search,
          method,
          headers: {
            'Content-Type': contentType,
            'Content-Length': body.length,
          },
          agent,
          timeout: 30_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(PodmanApiError.fromResponse(res.statusCode, data));
              return;
            }
            resolve();
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Podman API request timed out: ${method} ${path}`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<string>('/_ping');
      return true;
    } catch {
      return false;
    }
  }

  async info(): Promise<any> {
    const raw = await this.request<any>('/info');
    // Handle Docker-compatible API responses (Podman proxy returning Docker format)
    // Docker format has MemTotal at top level; Podman libpod format has host.memTotal
    if (raw && raw.MemTotal !== undefined && (raw.host === undefined || raw.host?.memTotal === undefined)) {
      return {
        host: {
          hostname: raw.Name,
          os: raw.OperatingSystem,
          kernelVersion: raw.KernelVersion,
          architecture: raw.Architecture,
          memTotal: raw.MemTotal,
          memFree: raw.SwapFree ?? null,
          uptime: raw.Uptime,
          cpuUtilization: raw.NCPU != null ? { userPercent: null } : undefined,
        },
        store: {
          containerStore: {
            running: raw.ContainersRunning ?? 0,
            paused: raw.ContainersPaused ?? 0,
            stopped: raw.ContainersStopped ?? 0,
            number: raw.Containers ?? 0,
          },
          imageStore: {
            number: raw.Images ?? 0,
          },
          volumeStore: {
            number: raw.Volumes ?? 0,
          },
        },
        version: { Version: raw.ServerVersion },
        _raw: raw,
      };
    }
    return raw;
  }

  async systemDf(): Promise<any> {
    try {
      return await this.request<any>('/libpod/system/df');
    } catch (err: any) {
      // Fallback to Docker-compatible endpoint if libpod returns 404
      if (err?.message?.includes('404')) {
        const dockerDf = await this.request<any>('/system/df');
        return {
          ImagesDiskUsage: (dockerDf.Images || []).map((img: any) => ({
            Id: img.Id,
            Size: img.Size,
            RepoTags: img.RepoTags,
          })),
          ContainersDiskUsage: (dockerDf.Containers || []).map((c: any) => ({
            Id: c.Id,
            Names: c.Names,
            Size: c.SizeRootFs ?? 0,
          })),
          VolumesDiskUsage: (dockerDf.Volumes || []).map((v: any) => ({
            Name: v.Name,
            UsageData: { Size: v.UsageData?.Size ?? 0 },
          })),
          _raw: dockerDf,
        };
      }
      throw err;
    }
  }

  async systemPrune(all: boolean = true): Promise<any> {
    return this.request<any>(`/v4.0.0/libpod/system/prune?all=${all}`, { method: 'POST' });
  }

  async events(since?: string, until?: string, filters?: Record<string, string[]>): Promise<any[]> {
    const params = new URLSearchParams();
    if (since) params.append('since', since);
    if (until) params.append('until', until);
    if (filters) {
      for (const [key, values] of Object.entries(filters)) {
        params.append('filters', JSON.stringify({ [key]: values }));
      }
    }
    params.append('stream', 'false');
    try {
      const res = await this.request<any>(`/libpod/events?${params}`);
      if (typeof res === 'string') {
        return res.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      }
      return Array.isArray(res) ? res : [res];
    } catch (err: any) {
      // Fallback to Docker-compatible endpoint if libpod returns 404
      if (err?.message?.includes('404')) {
        const res = await this.request<any>(`/events?${params}`);
        if (typeof res === 'string') {
          return res.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
        }
        return Array.isArray(res) ? res : [res];
      }
      throw err;
    }
  }

  async listContainers(all: boolean = true): Promise<Container[]> {
    return this.request<Container[]>(`/containers/json?all=${all}`);
  }

  async getContainer(id: string): Promise<ContainerInspect> {
    return this.request<ContainerInspect>(`/containers/${id}/json`);
  }

  private resolveImageName(image: string): string {
    if (image.includes('/') || image.startsWith('docker.io/') || image.startsWith('quay.io/') || image.startsWith('ghcr.io/')) {
      return image;
    }
    return `docker.io/library/${image}`;
  }

  async createContainer(config: {
    name?: string;
    image: string;
    env?: Record<string, string> | string[];
    ports?: Record<string, Array<{ hostPort: string }>>;
    labels?: Record<string, string>;
    restartPolicy?: string;
    command?: string[];
    entrypoint?: string[];
    workingDir?: string;
    binds?: string[];
    memory?: number;
    cpuPeriod?: number;
    cpuQuota?: number;
    healthcheck?: {
      test: string[];
      interval?: number;
      timeout?: number;
      retries?: number;
      startPeriod?: number;
    };
    networkMode?: string;
    networkAliases?: string[];
    /** Mount point → mount options, e.g. `{'/run/secrets': 'rw,mode=0700'}`. */
    tmpfs?: Record<string, string>;
  }): Promise<{ Id: string; Warnings: string[] }> {
    const resolvedImage = this.resolveImageName(config.image);

    try {
      await this.pullImage(resolvedImage);
    } catch (e) {
      // A failed pull is survivable only if the image is already on the worker.
      // It matters most for digest references: a rollback asks for specific
      // bytes, and quietly running something else — or failing later with
      // podman's own opaque error — is exactly what pinning was meant to stop.
      const present = await this.getImageJson(resolvedImage).then(() => true, () => false);
      if (!present) {
        const byDigest = resolvedImage.includes('@sha256:');
        throw new Error(
          byDigest
            ? `Image ${resolvedImage} could not be pulled and is not present on this worker. ` +
              `That digest may have been pruned from the registry or the tag deleted; ` +
              `the exact bytes this deployment recorded are no longer available.`
            : `Image ${resolvedImage} could not be pulled and is not present on this worker: ` +
              `${(e as Error)?.message ?? e}`,
        );
      }
      console.warn(`Failed to pull image ${resolvedImage}, using the copy already on the worker:`, e);
    }

    const containerConfig: any = {
      Image: resolvedImage,
      Labels: config.labels || {},
      Env: Array.isArray(config.env) ? config.env : (config.env ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`) : []),
      Cmd: config.command,
      Entrypoint: config.entrypoint,
      WorkingDir: config.workingDir,
      HostConfig: {
        RestartPolicy: {
          Name: config.restartPolicy || 'no',
        },
      },
    };

    if (config.healthcheck) {
      containerConfig.Healthcheck = {
        Test: config.healthcheck.test,
        Interval: config.healthcheck.interval || 0,
        Timeout: config.healthcheck.timeout || 0,
        Retries: config.healthcheck.retries || 0,
        StartPeriod: config.healthcheck.startPeriod || 0,
      };
    }

    if (config.networkMode && config.networkMode.trim() !== '') {
      containerConfig.HostConfig.NetworkMode = config.networkMode;
    }

    if (config.networkMode && config.networkAliases && config.networkAliases.length > 0) {
      containerConfig.NetworkingConfig = {
        EndpointsConfig: {
          [config.networkMode]: {
            Aliases: config.networkAliases,
          },
        },
      };
    }

    if (config.binds) {
      containerConfig.HostConfig.Binds = config.binds;
    }

    if (config.tmpfs && Object.keys(config.tmpfs).length > 0) {
      containerConfig.HostConfig.Tmpfs = config.tmpfs;
    }

    if (config.memory !== undefined) {
      containerConfig.HostConfig.Memory = config.memory;
    }
    
    if (config.cpuPeriod !== undefined) {
      containerConfig.HostConfig.CpuPeriod = config.cpuPeriod;
    }
    
    if (config.cpuQuota !== undefined) {
      containerConfig.HostConfig.CpuQuota = config.cpuQuota;
    }

    if (config.ports) {
      containerConfig.ExposedPorts = {};
      containerConfig.HostConfig.PortBindings = {};
      
      for (const [containerPort, bindings] of Object.entries(config.ports)) {
        containerConfig.ExposedPorts[containerPort] = {};
        containerConfig.HostConfig.PortBindings[containerPort] = bindings.map(b => ({
          // Loopback only. Podman defaults an omitted HostIp to 0.0.0.0, which
          // published every application straight onto the worker's public IP at
          // a random high port — bypassing Traefik, CrowdSec and OIDC entirely.
          // Traefik runs with host networking and proxies to 127.0.0.1:<port>,
          // so it still reaches them.
          HostIp: '127.0.0.1',
          HostPort: b.hostPort,
        }));
      }
    }

    // Name is passed as a query parameter in Podman REST API
    const queryParams = config.name ? `?name=${encodeURIComponent(config.name)}` : '';

    return this.request(`/containers/create${queryParams}`, {
      method: 'POST',
      body: JSON.stringify(containerConfig),
    });
  }

  async startContainer(id: string): Promise<void> {
    await this.request(`/containers/${id}/start`, { method: 'POST' });
  }

  /**
   * Extract a tar archive into a container's filesystem.
   *
   * Used to deliver file-mode secrets before the container starts. The archive
   * is built in memory and never touches the control plane's disk.
   *
   * Podman mounts the container's filesystem to service this, tmpfs mounts
   * included, so an upload to a not-yet-started container lands *in* the tmpfs
   * rather than in the image layer underneath it — verified against Podman
   * 4.9.3. That is what makes secret files possible without either running a
   * command in the container or giving up the tmpfs.
   */
  async putArchive(id: string, destPath: string, archive: Buffer): Promise<void> {
    await this.requestBinary(
      `/containers/${id}/archive?path=${encodeURIComponent(destPath)}`,
      'PUT',
      archive,
    );
  }

  async stopContainer(id: string, timeout: number = 10): Promise<void> {
    await this.request(`/containers/${id}/stop?t=${timeout}`, { method: 'POST' });
  }

  async restartContainer(id: string, timeout: number = 10): Promise<void> {
    await this.request(`/containers/${id}/restart?t=${timeout}`, { method: 'POST' });
  }

  async removeContainer(id: string, force: boolean = false): Promise<void> {
    await this.request(`/containers/${id}?force=${force}`, { method: 'DELETE' });
  }

  async listNetworks(): Promise<any[]> {
    return this.request<any[]>('/networks');
  }

  async createNetwork(name: string, driver: string = 'bridge'): Promise<{ Id: string }> {
    try {
      return await this.request<{ Id: string }>('/networks/create', {
        method: 'POST',
        body: JSON.stringify({ Name: name, Driver: driver }),
      });
    } catch (e: any) {
      // Network may already exist
      if (e.message?.includes('already exists') || e.message?.includes('409')) {
        return { Id: name };
      }
      throw e;
    }
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.request(`/networks/${name}`, { method: 'DELETE' });
    } catch (e: any) {
      if (!e.message?.includes('not found') && !e.message?.includes('404')) {
        throw e;
      }
    }
  }

  async connectContainerToNetwork(containerId: string, networkName: string): Promise<void> {
    await this.request(`/networks/${networkName}/connect`, {
      method: 'POST',
      body: JSON.stringify({ Container: containerId }),
    });
  }

  async disconnectContainerFromNetwork(containerId: string, networkName: string): Promise<void> {
    try {
      await this.request(`/networks/${networkName}/disconnect`, {
        method: 'POST',
        body: JSON.stringify({ Container: containerId }),
      });
    } catch (e: any) {
      if (!e.message?.includes('not found') && !e.message?.includes('404')) {
        throw e;
      }
    }
  }

  async listImages(): Promise<Image[]> {
    return this.request<Image[]>('/images/json');
  }

  async removeImage(id: string, force: boolean = false): Promise<void> {
    await this.request(`/images/${id}?force=${force}`, { method: 'DELETE' });
  }

  async pullImage(name: string, tag: string = 'latest'): Promise<void> {
    // A digest reference goes as fromImage + tag=sha256:… rather than one
    // combined string: `fromImage=repo@sha256:…` is accepted inconsistently,
    // and pulling by digest is the whole point of pinned deployments.
    const at = name.indexOf('@sha256:');
    if (at !== -1) {
      const repo = name.slice(0, at);
      const digest = name.slice(at + 1);
      await this.request(
        `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(digest)}`,
        { method: 'POST' },
      );
      return;
    }

    const imageName = name.includes(':') ? name : `${name}:${tag}`;
    await this.request('/images/create?fromImage=' + encodeURIComponent(imageName), {
      method: 'POST',
    });
  }

  async getContainerLogs(
    id: string,
    options: {
      stdout?: boolean;
      stderr?: boolean;
      tail?: number;
      timestamps?: boolean;
    } = {}
  ): Promise<string> {
    const params = new URLSearchParams();
    if (options.stdout) params.append('stdout', '1');
    if (options.stderr) params.append('stderr', '1');
    if (options.tail) params.append('tail', options.tail.toString());
    if (options.timestamps) params.append('timestamps', '1');

    const url = `${this.baseUrl}/containers/${id}/logs?${params}`;
    const nodeUrl = new URL(url);
    const agent = this.getAgent(url);
    const reqModule = nodeUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: nodeUrl.hostname,
        port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
        path: nodeUrl.pathname + nodeUrl.search,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        agent,
      };

      const req = reqModule.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const data = Buffer.concat(chunks);
          
          // Parse Docker multiplexed stream format
          // Each frame: [stream_type:1][padding:3][size:4-big-endian][payload:size]
          let result = '';
          let offset = 0;

          while (offset + 8 <= data.length) {
            const size = data.readUInt32BE(offset + 4);
            offset += 8;

            if (offset + size > data.length) {
              // Incomplete frame, append remainder as raw text
              result += data.subarray(offset - 8).toString('utf-8');
              break;
            }

            const payload = data.subarray(offset, offset + size).toString('utf-8');
            offset += size;
            result += payload;
          }

          // If no frames were parsed, treat as raw text
          if (offset === 0 && data.length > 0) {
            result = data.toString('utf-8');
          }

          resolve(result);
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.end();
    });
  }

  streamContainerLogs(
    id: string,
    options: {
      stdout?: boolean;
      stderr?: boolean;
      tail?: number;
      timestamps?: boolean;
      follow?: boolean;
    } = {},
    onData: (data: string) => void,
    onEnd: () => void,
    onError: (err: Error) => void
  ): { abort: () => void } {
    const params = new URLSearchParams();
    if (options.stdout !== false) params.append('stdout', '1');
    if (options.stderr !== false) params.append('stderr', '1');
    if (options.tail) params.append('tail', options.tail.toString());
    if (options.timestamps) params.append('timestamps', '1');
    if (options.follow !== false) params.append('follow', '1');
    params.append('stream', '1');

    const url = `${this.baseUrl}/containers/${id}/logs?${params}`;
    const nodeUrl = new URL(url);
    const agent = this.getAgent(url);
    const reqModule = nodeUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: nodeUrl.hostname,
      port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
      path: nodeUrl.pathname + nodeUrl.search,
      method: 'GET',
      headers: {
        'Connection': 'keep-alive',
      },
      agent,
    };

    const req = reqModule.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let buffer = Buffer.alloc(0);

      const processBuffer = () => {
        // Process Docker multiplexed stream format
        // Each frame: [stream_type:1][padding:3][size:4-big-endian][payload:size]
        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4);
          
          if (buffer.length < 8 + size) {
            // Wait for more data
            break;
          }

          const payload = buffer.subarray(8, 8 + size).toString('utf-8');
          buffer = buffer.subarray(8 + size);

          // Send each line
          const lines = payload.split('\n');
          for (const line of lines) {
            if (line) {
              onData(line);
            }
          }
        }
      };

      res.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        processBuffer();
      });

      res.on('end', () => {
        // Process any remaining data as raw text
        if (buffer.length > 0) {
          const remaining = buffer.toString('utf-8');
          const lines = remaining.split('\n');
          for (const line of lines) {
            if (line) {
              onData(line);
            }
          }
        }
        onEnd();
      });

      res.on('error', (err) => {
        onError(err);
      });
    });

    req.on('error', (err) => {
      onError(err);
    });

    req.end();

    return {
      abort: () => {
        req.destroy();
      }
    };
  }


  /**
   * Start an exec and return its live stream.
   *
   * This replaces an `execContainer` that opened `GET /containers/{id}/exec` as
   * a WebSocket, along with a matching `attachContainer`. Podman has no such
   * endpoints — the request is answered with a plain HTTP status and the
   * upgrade never happens, which is why the container terminal and
   * `kubectl exec` both connected and then died with "unexpected EOF". Both
   * methods are gone rather than left as traps.
   *
   * The real protocol is Docker's two-step hijack: create the exec, then POST
   * to `/exec/{id}/start` asking to upgrade the connection. What comes back is
   * the raw bidirectional stream — writes are stdin, reads are output.
   *
   * ── Why there is a fallback ────────────────────────────────────────────────
   *
   * Rudder reaches the Podman API through the worker's Traefik, for mTLS. That
   * hop proxies WebSocket upgrades but answers a `Upgrade: tcp` hijack with a
   * plain-text 500 — measured against Traefik 3.7.10 and Podman 4.9.3, with
   * the identical request succeeding as a normal POST. So the hijack is tried,
   * and when the proxy refuses it the same exec is started without the upgrade
   * headers: Podman then streams the output over an ordinary 200 response.
   *
   * Output is complete either way. Only stdin needs the hijack, so the
   * fallback reports `stdinAvailable: false` and callers say so rather than
   * accepting keystrokes that go nowhere.
   */
  async execContainerStream(
    id: string,
    cmd: string[],
    options: { tty?: boolean; stdin?: boolean } = {},
  ): Promise<ExecStream> {
    const tty = options.tty ?? true;
    const attachStdin = options.stdin ?? true;

    if (!attachStdin) {
      // Nothing to hijack for, so skip straight to the path that always works.
      return this.execStreamNoStdin(id, cmd, tty);
    }

    const created = await this.request<{ Id: string }>(`/containers/${id}/exec`, {
      method: 'POST',
      body: JSON.stringify({
        AttachStdin: attachStdin,
        AttachStdout: true,
        AttachStderr: true,
        Tty: tty,
        Cmd: cmd,
      }),
    });
    const execId = created.Id;

    const url = `${this.baseUrl}/exec/${execId}/start`;
    const nodeUrl = new URL(url);
    const reqModule = nodeUrl.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ Detach: false, Tty: tty });

    return new Promise<ExecStream>((resolve, reject) => {
      const req = reqModule.request({
        hostname: nodeUrl.hostname,
        port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
        path: nodeUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
        agent: this.getAgent(url),
      });

      let settled = false;
      const handlers = {
        stdout: [] as Array<(d: Buffer) => void>,
        stderr: [] as Array<(d: Buffer) => void>,
        end: [] as Array<() => void>,
      };

      const emitEnd = () => {
        for (const fn of handlers.end.splice(0)) fn();
      };

      /**
       * Without a TTY, Docker multiplexes the two streams into frames of
       * `[stream:1][pad:3][len:4 BE][payload]`. Reassembled here rather than in
       * the caller: a frame can be split across TCP reads, and treating a
       * partial header as payload puts binary garbage on the user's terminal.
       */
      const makeReader = () => {
        let buffered = Buffer.alloc(0);
        return (chunk: Buffer) => {
          if (tty) {
            for (const fn of handlers.stdout) fn(chunk);
            return;
          }
          buffered = Buffer.concat([buffered, chunk]);
          while (buffered.length >= 8) {
            const size = buffered.readUInt32BE(4);
            if (buffered.length < 8 + size) break;
            const streamType = buffered[0];
            const payload = buffered.subarray(8, 8 + size);
            buffered = buffered.subarray(8 + size);
            const target = streamType === 2 ? handlers.stderr : handlers.stdout;
            for (const fn of target) fn(payload);
          }
        };
      };

      const attach = (socket: import('net').Socket, head: Buffer) => {
        if (settled) return;
        settled = true;
        const read = makeReader();
        if (head?.length) read(head);
        socket.on('data', read);
        socket.on('end', emitEnd);
        socket.on('close', emitEnd);
        socket.on('error', emitEnd);

        resolve({
          execId,
          stdinAvailable: true,
          write: (data) => { if (!socket.destroyed) socket.write(data); },
          close: () => { try { socket.end(); } catch { /* already gone */ } },
          onStdout: (fn) => handlers.stdout.push(fn),
          onStderr: (fn) => handlers.stderr.push(fn),
          onEnd: (fn) => handlers.end.push(fn),
          inspect: () => this.inspectExec(execId),
        });
      };

      // 101: the connection was hijacked, and `socket` is the raw stream.
      req.on('upgrade', (_res, socket, head) => attach(socket as any, head));

      // Anything that is not a 101 means the upgrade did not happen. The exec
      // instance created above is still valid but was never started, so it is
      // abandoned and a fresh one runs without stdin.
      req.on('response', (res) => {
        if (settled) return;
        settled = true;
        res.resume();
        this.execStreamNoStdin(id, cmd, tty).then(resolve, reject);
      });

      req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
      req.write(body);
      req.end();
    });
  }

  /** Exit status of an exec instance; 0 when it cannot be read. */
  private async inspectExec(execId: string): Promise<{ exitCode: number; running: boolean }> {
    try {
      const res = await this.request<{ ExitCode: number | null; Running: boolean }>(
        `/exec/${execId}/json`,
      );
      return { exitCode: res.ExitCode ?? 0, running: !!res.Running };
    } catch {
      return { exitCode: 0, running: false };
    }
  }

  /**
   * Run an exec and stream its output over an ordinary response.
   *
   * No hijack, so no stdin — but nothing in the path can refuse it, which is
   * what makes it the fallback when the mTLS proxy rejects the upgrade.
   */
  private async execStreamNoStdin(id: string, cmd: string[], tty: boolean): Promise<ExecStream> {
    const created = await this.request<{ Id: string }>(`/containers/${id}/exec`, {
      method: 'POST',
      body: JSON.stringify({
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: tty,
        Cmd: cmd,
      }),
    });
    const execId = created.Id;

    const url = `${this.baseUrl}/exec/${execId}/start`;
    const nodeUrl = new URL(url);
    const reqModule = nodeUrl.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ Detach: false, Tty: tty });

    const handlers = {
      stdout: [] as Array<(d: Buffer) => void>,
      stderr: [] as Array<(d: Buffer) => void>,
      end: [] as Array<() => void>,
    };
    const emitEnd = () => { for (const fn of handlers.end.splice(0)) fn(); };

    let buffered = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      if (tty) {
        for (const fn of handlers.stdout) fn(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 8) {
        const size = buffered.readUInt32BE(4);
        if (buffered.length < 8 + size) break;
        const streamType = buffered[0];
        const payload = buffered.subarray(8, 8 + size);
        buffered = buffered.subarray(8 + size);
        for (const fn of streamType === 2 ? handlers.stderr : handlers.stdout) fn(payload);
      }
    };

    return new Promise<ExecStream>((resolve, reject) => {
      const req = reqModule.request({
        hostname: nodeUrl.hostname,
        port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
        path: nodeUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        agent: this.getAgent(url),
      });

      req.on('response', (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => reject(new Error(`exec start failed: ${res.statusCode} ${text}`)));
          return;
        }

        res.on('data', read);
        res.on('end', emitEnd);
        res.on('error', emitEnd);

        resolve({
          execId,
          stdinAvailable: false,
          write: () => { /* no stdin on this path — callers check stdinAvailable */ },
          close: () => { try { res.destroy(); } catch { /* already gone */ } },
          onStdout: (fn) => handlers.stdout.push(fn),
          onStderr: (fn) => handlers.stderr.push(fn),
          onEnd: (fn) => handlers.end.push(fn),
          inspect: () => this.inspectExec(execId),
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async execContainerHttp(
    id: string,
    cmd: string[] = ['/bin/sh'],
    options: {
      attachStdout?: boolean;
      attachStderr?: boolean;
      attachStdin?: boolean;
      tty?: boolean;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Without a TTY, Podman frames the two streams with an 8-byte header each,
    // which is the only way to tell them apart. With one, they are merged and
    // stderr is unrecoverable — which is why this used to return `stderr: ''`
    // unconditionally while the caller had a branch for colouring it red.
    const tty = options.tty ?? false;

    // Step 1: Create exec instance
    const createResult = await this.request<{ Id: string }>(`/containers/${id}/exec`, {
      method: 'POST',
      body: JSON.stringify({
        AttachStdout: options.attachStdout ?? true,
        AttachStderr: options.attachStderr ?? true,
        AttachStdin: options.attachStdin ?? false,
        Tty: tty,
        Cmd: cmd,
      }),
    });

    const execId = createResult.Id;

    // Step 2: Start exec and capture output
    const url = `${this.baseUrl}/exec/${execId}/start`;
    const nodeUrl = new URL(url);
    const agent = this.getAgent(url);
    const reqModule = nodeUrl.protocol === 'https:' ? https : http;

    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const reqOptions = {
        hostname: nodeUrl.hostname,
        port: nodeUrl.port || (nodeUrl.protocol === 'https:' ? 443 : 80),
        path: nodeUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        agent,
      };

      const req = reqModule.request(reqOptions, (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve());
        // Rejecting rather than resolving: a connection that died mid-command
        // used to be indistinguishable from a command that printed nothing and
        // exited 0, so a broken worker looked like a silent success.
        res.on('error', reject);
      });

      req.on('error', reject);
      req.write(JSON.stringify({ Detach: false, Tty: tty }));
      req.end();
    });

    const raw = Buffer.concat(chunks);
    const { stdout, stderr } = tty
      ? { stdout: raw.toString('utf-8'), stderr: '' }
      : demultiplexExecStream(raw);

    // Step 3: Read the exit code, allowing for the exec not having been reaped
    // yet. A fixed 50 ms sleep was a guess that got the wrong answer whenever
    // the worker was busy.
    let exitCode = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const inspectResult = await this.request<{
          ExitCode: number;
          Running: boolean;
        }>(`/exec/${execId}/json`);
        if (!inspectResult.Running) {
          exitCode = inspectResult.ExitCode ?? 0;
          break;
        }
      } catch {
        exitCode = 1;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    return { stdout, stderr, exitCode };
  }

  async getContainerStats(id: string): Promise<ContainerStats> {
    return this.request<ContainerStats>(`/containers/${id}/stats?stream=false`);
  }

  async getImageJson(name: string): Promise<ImageInspect> {
    return this.request<ImageInspect>(`/images/${encodeURIComponent(name)}/json`);
  }

  /**
   * The repo digest of a locally present image — `docker.io/library/nginx@sha256:…`.
   *
   * This is what makes a deployment record mean something: the tag says
   * `nginx:latest`, the digest says which bytes that was. Call it after a pull,
   * so the digest is the one this deploy fetched.
   *
   * Returns null when the image carries no repo digest at all: built on the
   * worker, loaded from an archive, or a registry that did not return one.
   * Callers fall back to the tag and should say so rather than pretend.
   */
  async resolveImageDigest(name: string): Promise<string | null> {
    try {
      const inspect = await this.getImageJson(name);
      const digest = inspect.RepoDigests?.[0];
      return digest && digest.includes('@sha256:') ? digest : null;
    } catch {
      return null;
    }
  }

  async getImageHistory(name: string): Promise<ImageHistoryEntry[]> {
    return this.request<ImageHistoryEntry[]>(`/images/${encodeURIComponent(name)}/history`);
  }

  destroy(): void {
    this.httpsAgent?.destroy();
    this.httpAgent?.destroy();
  }
}

export class SSHPodmanClient {
  private config: SSHPodmanConfig;

  constructor(config: SSHPodmanConfig) {
    this.config = config;
  }

  private async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sshConfig: SSHConnectionConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      privateKey: this.config.privateKey,
    };

    const result = await executeSSHCommand(sshConfig, command);
    return result;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.exec('podman version');
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async info(): Promise<any> {
    const result = await this.exec('podman info --format json');
    if (result.exitCode !== 0) {
      throw new Error(`podman info failed: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  }

  async listContainers(all: boolean = true): Promise<Container[]> {
    const result = await this.exec(`podman ps -a --format json`);
    if (result.exitCode !== 0) {
      throw new Error(`podman ps failed: ${result.stderr}`);
    }
    const lines = result.stdout.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return [];
    return lines.map(l => JSON.parse(l));
  }

  async getContainer(id: string): Promise<ContainerInspect> {
    const result = await this.exec(`podman inspect ${id}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman inspect failed: ${result.stderr}`);
    }
    const containers = JSON.parse(result.stdout);
    if (!containers || containers.length === 0) {
      throw new Error(`Container ${id} not found`);
    }
    return containers[0];
  }

  private resolveImageName(image: string): string {
    // If the image already has a registry or slash, use as-is
    if (image.includes('/') || image.startsWith('docker.io/') || image.startsWith('quay.io/') || image.startsWith('ghcr.io/')) {
      return image;
    }
    // Common short names - add docker.io/library/ prefix
    return `docker.io/library/${image}`;
  }

  async createContainer(config: {
    name?: string;
    image: string;
    env?: Record<string, string> | string[];
    ports?: Record<string, Array<{ hostPort: string }>>;
    labels?: Record<string, string>;
    restartPolicy?: string;
    command?: string[];
    entrypoint?: string[];
    workingDir?: string;
    binds?: string[];
    memory?: number;
    cpuPeriod?: number;
    cpuQuota?: number;
  }): Promise<{ Id: string; Warnings: string[] }> {
    // Resolve image name to full path
    const resolvedImage = this.resolveImageName(config.image);
    
    // First try to pull the image
    const pullResult = await this.exec(`podman pull ${resolvedImage}`);
    if (pullResult.exitCode !== 0) {
      console.warn(`Failed to pull image ${resolvedImage}: ${pullResult.stderr}`);
    }

    let cmd = `podman run -d`;
    
    if (config.name) {
      cmd += ` --name ${config.name}`;
    }
    
    if (config.labels) {
      for (const [key, value] of Object.entries(config.labels)) {
        // Escape single quotes and wrap in single quotes for shell safety
        const escapedValue = value.replace(/'/g, "'\\''");
        cmd += ` --label '${key}=${escapedValue}'`;
      }
    }
    
    if (config.env) {
      const envArray = Array.isArray(config.env) 
        ? config.env 
        : Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
      for (const env of envArray) {
        cmd += ` -e ${env}`;
      }
    }
    
    if (config.restartPolicy && config.restartPolicy !== 'no') {
      const policyMap: Record<string, string> = {
        'always': 'always',
        'on-failure': 'on-failure',
        'unless-stopped': 'unless-stopped',
      };
      cmd += ` --restart ${policyMap[config.restartPolicy] || 'no'}`;
    }
    
    if (config.ports) {
      for (const [containerPort, bindings] of Object.entries(config.ports)) {
        // Strip /tcp or /udp suffix from container port
        const port = containerPort.replace(/\/(tcp|udp)$/i, '');
        for (const binding of bindings) {
          // Loopback only — see the REST client's PortBindings for why.
          cmd += ` -p 127.0.0.1:${binding.hostPort}:${port}`;
        }
      }
    }
    
    if (config.binds) {
      for (const bind of config.binds) {
        cmd += ` -v ${bind}`;
      }
    }
    
    if (config.memory) {
      cmd += ` --memory=${config.memory}`;
    }
    
    if (config.cpuPeriod) {
      cmd += ` --cpu-period=${config.cpuPeriod}`;
    }
    
    if (config.cpuQuota) {
      cmd += ` --cpu-quota=${config.cpuQuota}`;
    }
    
    if (config.workingDir) {
      cmd += ` -w ${config.workingDir}`;
    }
    
    cmd += ` ${resolvedImage}`;
    
    // Command arguments go after the image
    if (config.command && config.command.length > 0) {
      cmd += ` ${config.command.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' ')}`;
    }

    const result = await this.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`podman run failed: ${result.stderr}`);
    }
    
    const containerId = result.stdout.trim();
    return { Id: containerId, Warnings: [] };
  }

  async startContainer(id: string): Promise<void> {
    const result = await this.exec(`podman start ${id}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman start failed: ${result.stderr}`);
    }
  }

  async stopContainer(id: string, timeout: number = 10): Promise<void> {
    const result = await this.exec(`podman stop -t ${timeout} ${id}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman stop failed: ${result.stderr}`);
    }
  }

  async restartContainer(id: string, timeout: number = 10): Promise<void> {
    const result = await this.exec(`podman restart -t ${timeout} ${id}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman restart failed: ${result.stderr}`);
    }
  }

  async removeContainer(id: string, force: boolean = false): Promise<void> {
    const result = await this.exec(`podman rm ${force ? '-f' : ''} ${id}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman rm failed: ${result.stderr}`);
    }
  }

  async listImages(): Promise<Image[]> {
    const result = await this.exec('podman images --format json');
    if (result.exitCode !== 0) {
      throw new Error(`podman images failed: ${result.stderr}`);
    }
    const lines = result.stdout.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return [];
    return lines.map(l => JSON.parse(l));
  }

  async removeImage(id: string, force: boolean = false): Promise<void> {
    const result = await this.exec(`podman rmi ${force ? '-f' : ''} ${id}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman rmi failed: ${result.stderr}`);
    }
  }

  async pullImage(name: string, tag: string = 'latest'): Promise<void> {
    const imageName = name.includes(':') ? name : `${name}:${tag}`;
    const result = await this.exec(`podman pull ${imageName}`);
    if (result.exitCode !== 0) {
      throw new Error(`podman pull failed: ${result.stderr}`);
    }
  }

  async getContainerLogs(
    id: string,
    options: {
      stdout?: boolean;
      stderr?: boolean;
      tail?: number;
      timestamps?: boolean;
    } = {}
  ): Promise<string> {
    let cmd = `podman logs`;
    
    if (options.tail) {
      cmd += ` --tail ${options.tail}`;
    }
    
    if (options.timestamps) {
      cmd += ` -t`;
    }
    
    cmd += ` ${id}`;
    
    const result = await this.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`podman logs failed: ${result.stderr}`);
    }
    
    return result.stdout;
  }

  async execContainer(
    id: string,
    cmd: string[] = ['/bin/sh'],
    options: {
      attachStdout?: boolean;
      attachStderr?: boolean;
      attachStdin?: boolean;
      tty?: boolean;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const escapedArgs = cmd.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const fullCmd = `podman exec ${id} ${escapedArgs}`;
    
    const result = await this.exec(fullCmd);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  destroy(): void {
  }
}

export function createPodmanClient(config: PodmanConfig): PodmanClient {
  return new PodmanClient(config);
}

export function createSSHPodmanClient(config: SSHPodmanConfig): SSHPodmanClient {
  return new SSHPodmanClient(config);
}
