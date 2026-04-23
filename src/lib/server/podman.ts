import https from 'https';
import http from 'http';
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
  return readFileSync(value);    // file path (legacy/dev usage)
}

export interface PodmanConfig {
  apiUrl: string;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
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
  };
  HostConfig: {
    RestartPolicy?: {
      Name: string;
    };
    PortBindings?: Record<string, Array<{ HostPort: string }>>;
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

      if (config.caCert) {
        httpsAgentOptions.ca = resolveCert(config.caCert);
      }

      if (config.clientCert && config.clientKey) {
        httpsAgentOptions.cert = resolveCert(config.clientCert);
        httpsAgentOptions.key = resolveCert(config.clientKey);
        // Use CA cert if provided (for verifying the server's cert)
        // When caCert is our own CA, accept only server certs signed by our CA
        // When no caCert, accept any server cert (but client still authenticates with cert)
        if (config.caCert) {
          httpsAgentOptions.ca = resolveCert(config.caCert);
          // The server cert may be a Traefik default cert until Let's Encrypt issues one.
          // We still authenticate the client with the client cert (mTLS).
          httpsAgentOptions.rejectUnauthorized = false;
        } else {
          httpsAgentOptions.rejectUnauthorized = false;
        }
      } else if (config.caCert) {
        httpsAgentOptions.ca = resolveCert(config.caCert);
        httpsAgentOptions.rejectUnauthorized = true;
      } else {
        httpsAgentOptions.rejectUnauthorized = false;
      }

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
      };

      const req = reqModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Podman API error: ${res.statusCode} - ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(data as unknown as T);
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(body);
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
      return await this.request<any[]>(`/libpod/events?${params}`);
    } catch (err: any) {
      // Fallback to Docker-compatible endpoint if libpod returns 404
      if (err?.message?.includes('404')) {
        return await this.request<any[]>(`/events?${params}`);
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
  }): Promise<{ Id: string; Warnings: string[] }> {
    const resolvedImage = this.resolveImageName(config.image);
    
    try {
      await this.pullImage(resolvedImage);
    } catch (e) {
      console.warn(`Failed to pull image ${resolvedImage}:`, e);
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

    if (config.networkMode) {
      containerConfig.HostConfig.NetworkMode = config.networkMode;
    }

    if (config.binds) {
      containerConfig.HostConfig.Binds = config.binds;
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

  attachContainer(
    id: string,
    options: {
      stream?: boolean;
      stdin?: boolean;
      stdout?: boolean;
      stderr?: boolean;
    } = {}
  ): Promise<WebSocket> {
    const params = new URLSearchParams();
    if (options.stream !== false) params.append('stream', '1');
    if (options.stdin !== false) params.append('stdin', '1');
    if (options.stdout !== false) params.append('stdout', '1');
    if (options.stderr !== false) params.append('stderr', '1');

    const wsUrl = `${this.baseUrl.replace('http', 'ws')}/containers/${id}/attach?${params}`;
    
    return new Promise((resolve, reject) => {
      const wsOpts: any = {
        rejectUnauthorized: false,
      };
      
      if (this.httpsAgent) {
        wsOpts.agent = this.httpsAgent;
        const agentOpts = (this.httpsAgent as any).options;
        if (agentOpts) {
          if (agentOpts.cert) wsOpts.cert = agentOpts.cert;
          if (agentOpts.key) wsOpts.key = agentOpts.key;
          if (agentOpts.ca) wsOpts.ca = agentOpts.ca;
        }
      }
      
      const ws = new WebSocket(wsUrl, wsOpts);

      ws.on('open', () => resolve(ws));
      ws.on('error', (err) => reject(err));
    });
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
  ): Promise<WebSocket> {
    const params = new URLSearchParams();
    params.append('cmd', JSON.stringify(cmd));
    if (options.attachStdout !== false) params.append('stdout', '1');
    if (options.attachStderr !== false) params.append('stderr', '1');
    if (options.attachStdin !== false) params.append('stdin', '1');
    if (options.tty) params.append('tty', '1');

    const wsUrl = `${this.baseUrl.replace('http', 'ws')}/containers/${id}/exec?${params}`;
    
    return new Promise((resolve, reject) => {
      const wsOpts: any = {
        rejectUnauthorized: false,
      };
      
      if (this.httpsAgent) {
        wsOpts.agent = this.httpsAgent;
        // Explicitly pass TLS options for mTLS
        const agentOpts = (this.httpsAgent as any).options;
        if (agentOpts) {
          if (agentOpts.cert) wsOpts.cert = agentOpts.cert;
          if (agentOpts.key) wsOpts.key = agentOpts.key;
          if (agentOpts.ca) wsOpts.ca = agentOpts.ca;
        }
      }
      
      const ws = new WebSocket(wsUrl, wsOpts);

      ws.on('open', () => resolve(ws));
      ws.on('error', (err) => reject(err));
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
    // Step 1: Create exec instance
    const createResult = await this.request<{ Id: string }>(`/containers/${id}/exec`, {
      method: 'POST',
      body: JSON.stringify({
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: true,
        Cmd: cmd,
      }),
    });

    const execId = createResult.Id;

    // Step 2: Start exec and capture output
    const url = `${this.baseUrl}/exec/${execId}/start`;
    const nodeUrl = new URL(url);
    const agent = this.getAgent(url);
    const reqModule = nodeUrl.protocol === 'https:' ? https : http;

    let stdout = '';

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
        res.setEncoding('utf-8');
        
        res.on('data', (chunk: string) => {
          stdout += chunk;
        });

        res.on('end', () => resolve());
        res.on('error', () => resolve());
      });

      req.on('error', () => resolve());
      req.write(JSON.stringify({ Detach: false, Tty: true }));
      req.end();
    });

    // Step 3: Wait briefly then inspect exec to get exit code
    await new Promise(r => setTimeout(r, 50));
    
    let exitCode = 0;
    try {
      const inspectResult = await this.request<{
        ExitCode: number;
        Running: boolean;
      }>(`/exec/${execId}/json`);
      exitCode = inspectResult.ExitCode;
    } catch {
      exitCode = 1;
    }

    return { stdout, stderr: '', exitCode };
  }

  async getContainerStats(id: string): Promise<ContainerStats> {
    return this.request<ContainerStats>(`/containers/${id}/stats?stream=false`);
  }

  async getImageJson(name: string): Promise<ImageInspect> {
    return this.request<ImageInspect>(`/images/${encodeURIComponent(name)}/json`);
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
          cmd += ` -p ${binding.hostPort}:${port}`;
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
