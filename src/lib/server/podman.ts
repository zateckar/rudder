/**
 * The Podman REST API client. Nothing here shells out.
 *
 * There used to be an `SSHPodmanClient` alongside `PodmanClient` that ran
 * `podman ps`, `podman logs`, `podman rmi` and the rest as command *strings*
 * over SSH. Its command builders were deleted years-of-commits ago for
 * interpolating unescaped user input into a remote shell; what remained was a
 * 154-line class with exactly one consumer, `/api/workers/[id]/reconnect`,
 * which used it to run one `podman ps` as a connectivity probe. Ten of its
 * twelve methods were unreachable.
 *
 * It is gone rather than trimmed: a second, weaker way to reach a worker is a
 * trap for whoever needs one next, and mTLS over the REST API is the path that
 * should be taken. The reconnect route now runs its own one-line probe through
 * `executeSSHCommand`, which is where SSH belongs.
 */
import https from 'https';
import http from 'http';
import tls from 'tls';
import { readFileSync } from 'fs';
import { URL } from 'url';

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

  /**
   * Whether an unknown thrown value is a Podman refusal with this status.
   *
   * The call sites used to ask `err.message.includes('404')`, which is true of
   * any error whose text happens to contain those three digits — a pull of
   * `nginx:1.404`, say — and which only works at all because the message
   * embeds the status. This reads the field that exists for the purpose.
   */
  static hasStatus(error: unknown, status: number): boolean {
    return error instanceof PodmanApiError && error.status === status;
  }

  /**
   * Whether this error says *the container does not exist*, as opposed to
   * anything else that produces a 404.
   *
   * The distinction is the whole point, and `removeVolume` is the cautionary
   * tale: it read a bare 404 as "already gone", which is right for a volume that
   * is not there and catastrophically wrong for a *route* that is not there —
   * Podman serves its libpod volume API only under a version prefix, so every
   * delete returned success and deleted nothing. See `podman-volumes.test.ts`.
   *
   * `removeContainer` is far less exposed to that — the compat container routes
   * are the same family every other call in the system uses, so a missing route
   * would break creating and starting containers too, loudly — but the cost of
   * being wrong here is a row deleted while its container is still running and
   * still holding the host port the row was reserving. So the status is not
   * enough on its own: Podman names the container in the body when the container
   * is what is missing, and answers an unknown route with a bare "page not
   * found" that mentions no container at all.
   *
   * Anything that does not clearly say the container is gone is treated as a
   * real failure — which is the direction that merely retries and now reports,
   * rather than the one that loses track of a running container.
   */
  isMissingContainer(): boolean {
    if (this.status !== 404) return false;
    return /no such container/i.test(this.detail);
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
 * A streaming reader for Podman's multiplexed output.
 *
 * Without a TTY, both the exec and the logs endpoints prefix every write with
 * an 8-byte header: byte 0 is the stream (1 = stdout, 2 = stderr) and bytes 4–7
 * are the payload length, big-endian. With a TTY there are no headers at all —
 * the pty has already merged the streams — so the chunk is passed through.
 *
 * Buffering belongs here rather than in each caller: a frame can be split
 * across TCP reads, and treating a partial header as payload puts binary
 * garbage on the user's terminal. There were five hand-written copies of this
 * loop in this file — two in the exec paths, two in the logs paths, and the
 * one-shot `demultiplexExecStream` below — and the two logs copies had already
 * drifted, discarding the stream byte so stderr came back labelled as stdout.
 */
export function createFrameReader(options: {
  tty: boolean;
  onStdout: (payload: Buffer) => void;
  onStderr?: (payload: Buffer) => void;
}): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0);

  return (chunk: Buffer) => {
    if (options.tty) {
      options.onStdout(chunk);
      return;
    }

    buffered = Buffer.concat([buffered, chunk]);

    while (buffered.length >= 8) {
      const streamType = buffered[0];
      const size = buffered.readUInt32BE(4);
      if (buffered.length < 8 + size) break;

      const payload = buffered.subarray(8, 8 + size);
      buffered = buffered.subarray(8 + size);

      if (streamType === 2 && options.onStderr) options.onStderr(payload);
      else options.onStdout(payload);
    }
  };
}

/**
 * Split Podman's multiplexed exec output into the two streams.
 *
 * The one-shot form, for a response that has already been read whole. A
 * trailing partial frame is kept rather than dropped — it is output that was
 * written, just cut short.
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

/** Prevents a hung request from blocking the metrics scheduler. */
const REQUEST_TIMEOUT_MS = 30_000;

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

/**
 * A named Podman volume, in the one shape both APIs are normalised into.
 *
 * Lowercased fields, unlike the pass-through `Container` and `Image` above,
 * because there is no single upstream spelling to be faithful to: libpod and the
 * Docker-compatible route disagree, and `listVolumes` reconciles them.
 *
 * No size field. Podman reports volume usage only in aggregate, through
 * `system/df` — see `volumeUsage`.
 */
export interface PodmanVolume {
  name: string;
  /** Where the volume lives on the worker's filesystem. */
  mountpoint: string | null;
  /** As Podman formats it — an RFC 3339 string, not a Date. */
  createdAt: string | null;
  labels: Record<string, string>;
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

/** One volume's disk usage, in the one shape `systemDf` callers may rely on. */
export interface VolumeDiskUsage {
  Name: string;
  UsageData: { Size: number };
}

/**
 * Reconcile the two spellings of a `system/df` volume entry.
 *
 * The two APIs disagree and the disagreement was silently costing every reader
 * the number it wanted: libpod answers `{VolumeName, Size}`, the
 * Docker-compatible route answers `{Name, UsageData: {Size}}`, and all three
 * call sites read `v.UsageData?.Size`. libpod is the route actually taken, so
 * volume disk usage reported as 0 bytes on every real Podman worker — on the
 * worker detail page, in the metrics sweep, and in the collection endpoint.
 *
 * Both spellings are accepted rather than one asserted: which shape a given
 * Podman build answers with is not worth pinning a number to.
 */
export function normalizeVolumeUsage(raw: unknown): VolumeDiskUsage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v: any) => ({
    Name: v?.VolumeName ?? v?.Name ?? '',
    UsageData: { Size: v?.Size ?? v?.UsageData?.Size ?? 0 },
  }));
}

/** A normalised `system/df` response as a name → bytes map. */
export function volumeUsageMap(df: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const entry of normalizeVolumeUsage((df as any)?.VolumesDiskUsage)) {
    if (entry.Name) sizes.set(entry.Name, entry.UsageData.Size);
  }
  return sizes;
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

  /**
   * The Node request module and options for a path on this worker.
   *
   * `fetch` is not used anywhere in this class: it has no way to take a custom
   * agent, and the agent is what carries the mTLS client certificate. That left
   * every method building the same `{hostname, port, path, method, headers,
   * agent}` object by hand — five copies, which is how two of them ended up
   * with no timeout at all while `request` had two.
   */
  private plan(
    path: string,
    method: string,
    extra: { headers?: Record<string, string | number>; timeoutMs?: number | null } = {},
  ) {
    const url = `${this.baseUrl}${path}`;
    const parsed = new URL(url);
    return {
      module: parsed.protocol === 'https:' ? https : http,
      options: {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: extra.headers ?? {},
        agent: this.getAgent(url),
        // `null` means "no socket timeout", which is what a followed log stream
        // needs: it is idle by design between lines.
        ...(extra.timeoutMs === null ? {} : { timeout: extra.timeoutMs ?? REQUEST_TIMEOUT_MS }),
      },
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method as string) || 'GET';
    const body = options.body as string | undefined;

    const { module: reqModule, options: reqOptions } = this.plan(path, method, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    });

    return new Promise<T>((resolve, reject) => {
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

      // A second timer, because the socket `timeout` above only fires on
      // *inactivity*: a worker dribbling one byte a second keeps resetting it.
      const absoluteTimeout = setTimeout(() => {
        req.destroy(new Error(`Podman API request absolute timeout: ${method} ${path}`));
      }, REQUEST_TIMEOUT_MS);

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
    const { module: reqModule, options: reqOptions } = this.plan(path, method, {
      headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    });

    return new Promise<void>((resolve, reject) => {
      const req = reqModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(PodmanApiError.fromResponse(res.statusCode, data));
            return;
          }
          resolve();
        });
      });

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
      const libpodDf = await this.request<any>('/libpod/system/df');
      return {
        ...libpodDf,
        VolumesDiskUsage: normalizeVolumeUsage(libpodDf?.VolumesDiskUsage),
      };
    } catch (err: unknown) {
      // Fallback to Docker-compatible endpoint if libpod returns 404
      if (PodmanApiError.hasStatus(err, 404)) {
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
          VolumesDiskUsage: normalizeVolumeUsage(dockerDf.Volumes),
          _raw: dockerDf,
        };
      }
      throw err;
    }
  }

  /**
   * Every volume's disk usage on this worker, by name.
   *
   * One `system/df` per caller rather than one per volume: Podman has no
   * per-volume size endpoint at all — `volumes/{name}/json` reports the
   * mountpoint and labels and nothing about how much is under it.
   */
  async volumeUsage(): Promise<Map<string, number>> {
    return volumeUsageMap(await this.systemDf());
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
    } catch (err: unknown) {
      // Fallback to Docker-compatible endpoint if libpod returns 404
      if (PodmanApiError.hasStatus(err, 404)) {
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

  /**
   * Make sure `image` can be run on this worker, and return its resolved name.
   *
   * Extracted from `createContainer`, which is still the main caller, so that an
   * operation whose *first* step destroys something can establish this before
   * taking that step. `restoreVolume` is the case: it removes and recreates the
   * volume before the helper container exists, so a pull that fails there — an
   * air-gapped worker, a rate-limited registry, `VOLUME_TOOL_IMAGE` pruned off
   * the worker by Rudder's own prune — used to leave the volume empty and the
   * archive unapplied.
   *
   * @throws when the image can be neither pulled nor found already present.
   */
  async ensureImage(image: string): Promise<string> {
    const resolvedImage = this.resolveImageName(image);

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

    return resolvedImage;
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
    const resolvedImage = await this.ensureImage(config.image);

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

  /**
   * Remove a container, treating one that is already gone as success.
   *
   * A caller that wants "make sure this is not there" should not have to
   * reimplement the 404 reasoning. Two of them did not, and both wedged
   * permanently on a row whose container had vanished: every sweep asked Podman
   * to remove a container that was not there, took the 404 as a failure, kept the
   * row, and tried again on the next cycle forever. The row held its host port
   * out of the allocator, was offered as a fast rollback that could not work, and
   * could not be cleared from any interface. `removeNetwork` below has always
   * taken this view of its own 404.
   *
   * Returns whether anything was actually removed, so a caller can distinguish
   * "I removed it" from "it was already gone" where that matters.
   */
  async ensureContainerRemoved(id: string, force: boolean = false): Promise<boolean> {
    try {
      await this.removeContainer(id, force);
      return true;
    } catch (e: unknown) {
      if (e instanceof PodmanApiError && e.isMissingContainer()) return false;
      throw e;
    }
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
    } catch (e: unknown) {
      // Already there is the same outcome as having just made it. The name is
      // the id for Podman networks, so there is nothing further to look up.
      if (PodmanApiError.hasStatus(e, 409)) return { Id: name };
      throw e;
    }
  }

  /** Removing a network that is already gone is a success, not a failure. */
  async removeNetwork(name: string): Promise<void> {
    try {
      await this.request(`/networks/${name}`, { method: 'DELETE' });
    } catch (e: unknown) {
      if (!PodmanApiError.hasStatus(e, 404)) throw e;
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
    } catch (e: unknown) {
      // Neither the network nor the attachment being there is the outcome
      // asked for.
      if (!PodmanApiError.hasStatus(e, 404)) throw e;
    }
  }

  // ── Volumes ────────────────────────────────────────────────────────────────
  //
  // Podman creates a named volume implicitly the first time a container mounts
  // one, which is how every compose application's storage comes into being
  // without anything here being called. These exist so that storage can also be
  // listed, measured, copied and removed — the operations Rudder had no way to
  // perform on data it had created.

  /**
   * Call a libpod volume route, falling back to the Docker-compatible one.
   *
   * The libpod volume API is **only served under a version prefix**. Verified
   * against a real worker: `/libpod/volumes/json`, `/libpod/volumes/create`,
   * `/libpod/volumes/{name}/json` and `DELETE /libpod/volumes/{name}` all answer
   * a bare `404 Not Found`, while the same paths under `/v4.0.0/` work. The
   * version is spelled the same way `systemPrune` already spells it.
   *
   * That is the reason this is a method rather than four inline try/catches, and
   * the reason `removeVolume` reads the error from the *fallback* rather than the
   * first attempt. A 404 from a route that does not exist and a 404 meaning "no
   * such volume" are indistinguishable by status, so a caller that treats 404 as
   * "already gone" silently reports success for every delete it never sent — the
   * bug this shape exists to make impossible. Whatever this throws came from a
   * route that is definitely there: `/volumes/{name}` is part of the Docker API
   * every Podman serves.
   */
  private async volumeRequest<T>(
    path: string,
    dockerPath: string,
    options: RequestInit = {},
  ): Promise<T> {
    try {
      return await this.request<T>(`/v4.0.0/libpod/volumes${path}`, options);
    } catch (err: unknown) {
      if (!PodmanApiError.hasStatus(err, 404)) throw err;
      return this.request<T>(`/volumes${dockerPath}`, options);
    }
  }

  private static toVolume(raw: any, fallbackName = ''): PodmanVolume {
    return {
      name: raw?.Name ?? fallbackName,
      mountpoint: raw?.Mountpoint ?? null,
      createdAt: raw?.CreatedAt ?? null,
      labels: raw?.Labels ?? {},
    };
  }

  /**
   * Every named volume on this worker.
   *
   * libpod answers a bare array; the Docker route wraps the same objects in
   * `{Volumes: [...]}`. Normalised so callers never branch on which replied.
   */
  async listVolumes(): Promise<PodmanVolume[]> {
    const raw = await this.volumeRequest<any>('/json', '');
    const list = Array.isArray(raw) ? raw : (raw?.Volumes ?? []);
    return list.map((v: any) => PodmanClient.toVolume(v));
  }

  /**
   * Create a named volume.
   *
   * Already there is the same outcome as having just made it — the same reading
   * `createNetwork` takes of a 409, and the one that matters here: a restore
   * recreates the volume it is about to fill, and a concurrent deploy may have
   * got there first.
   */
  async createVolume(name: string, labels?: Record<string, string>): Promise<void> {
    try {
      await this.volumeRequest('/create', '/create', {
        method: 'POST',
        body: JSON.stringify({ Name: name, Labels: labels ?? {} }),
      });
    } catch (e: unknown) {
      if (PodmanApiError.hasStatus(e, 409)) return;
      throw e;
    }
  }

  /**
   * Remove a named volume and everything written to it.
   *
   * A volume that is already gone is a success, as with `removeNetwork` — and
   * safe to read that way here only because `volumeRequest` guarantees the 404
   * came from a route that exists. A 409 — Podman refusing because a container
   * still mounts it — is deliberately let through: that is a rule the caller has
   * broken and can act on, and `route()` relays a 4xx from Podman as itself.
   * `force` is the caller's explicit override, never the default.
   *
   * Returns whether a volume was actually removed, so a caller can say which of
   * the two happened. Reporting "already gone" as a deletion claims disk was
   * reclaimed that never existed, and a declared volume nothing ever deployed is
   * the ordinary way to arrive here.
   */
  async removeVolume(name: string, force: boolean = false): Promise<boolean> {
    const encoded = encodeURIComponent(name);
    try {
      await this.volumeRequest(
        `/${encoded}?force=${force}`,
        `/${encoded}?force=${force}`,
        { method: 'DELETE' },
      );
      return true;
    } catch (e: unknown) {
      if (PodmanApiError.hasStatus(e, 404)) return false;
      throw e;
    }
  }

  /** Mountpoint, labels and creation time for one volume. Says nothing about size. */
  async inspectVolume(name: string): Promise<PodmanVolume> {
    const encoded = encodeURIComponent(name);
    return PodmanClient.toVolume(
      await this.volumeRequest<any>(`/${encoded}/json`, `/${encoded}`),
      name,
    );
  }

  /**
   * Block until a container exits, and report its status code.
   *
   * `timeoutMs: null` for the same reason a followed log stream needs it: the
   * request is idle by design for as long as the container runs, so a socket
   * inactivity timeout would kill exactly the copies that are doing work.
   */
  async waitContainer(id: string): Promise<number> {
    const { module: reqModule, options: reqOptions } = this.plan(
      `/containers/${id}/wait`,
      'POST',
      { timeoutMs: null },
    );

    return new Promise<number>((resolve, reject) => {
      const req = reqModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(PodmanApiError.fromResponse(res.statusCode, data));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            // libpod answers with a bare integer; Docker with {StatusCode}.
            resolve(typeof parsed === 'number' ? parsed : (parsed?.StatusCode ?? 0));
          } catch {
            reject(new Error(`Could not read the exit status of container ${id}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Read a directory out of a container as a tar stream.
   *
   * The read counterpart of `putArchive`, and the mechanism behind `docker cp`.
   * Returns the response rather than a buffer: a volume backup is arbitrarily
   * large, and the control plane must not hold one in memory to hand it to the
   * browser. Entries come back prefixed with the basename of `path`, so a
   * `path` of `/volume` produces `volume/...` — which is what makes the round
   * trip through `putArchiveStream(id, '/')` land the files back where they were.
   */
  async getArchiveStream(id: string, path: string): Promise<http.IncomingMessage> {
    const { module: reqModule, options: reqOptions } = this.plan(
      `/containers/${id}/archive?path=${encodeURIComponent(path)}`,
      'GET',
      { timeoutMs: null },
    );

    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = reqModule.request(reqOptions, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => reject(PodmanApiError.fromResponse(res.statusCode!, data)));
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Extract a tar stream into a container, without buffering it.
   *
   * `putArchive` takes a Buffer, which is right for the few kilobytes of secret
   * files it was written for and wrong for a restored volume. Chunked transfer
   * encoding — no Content-Length — because the size is not known until the
   * upload ends.
   */
  async putArchiveStream(
    id: string,
    destPath: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const { module: reqModule, options: reqOptions } = this.plan(
      `/containers/${id}/archive?path=${encodeURIComponent(destPath)}`,
      'PUT',
      { headers: { 'Content-Type': 'application/x-tar' }, timeoutMs: null },
    );

    return new Promise<void>((resolve, reject) => {
      const req = reqModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(PodmanApiError.fromResponse(res.statusCode, data));
            return;
          }
          resolve();
        });
      });
      req.on('error', reject);

      (async () => {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!req.write(value)) {
              // Both outcomes, or a request that fails while the buffer is full
              // leaves this await pending forever and the reader never released.
              // Each listener removes the other so a long upload does not
              // accumulate one pair per chunk.
              await new Promise<void>((resolveDrain, rejectDrain) => {
                const onDrain = () => {
                  req.off('error', onError);
                  resolveDrain();
                };
                const onError = (err: Error) => {
                  req.off('drain', onDrain);
                  rejectDrain(err);
                };
                req.once('drain', onDrain);
                req.once('error', onError);
              });
            }
          }
          req.end();
        } catch (e) {
          // Destroying the request is what makes a truncated upload a failure
          // rather than a half-extracted volume Podman thinks it finished.
          req.destroy(e instanceof Error ? e : new Error(String(e)));
        } finally {
          reader.releaseLock();
        }
      })();
    });
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

    // This had no timeout of any kind, so a worker that accepted the connection
    // and then went quiet held the request open indefinitely.
    const { module: reqModule, options: reqOptions } = this.plan(
      `/containers/${id}/logs?${params}`,
      'GET',
      { headers: { 'Content-Type': 'application/json' } },
    );

    return new Promise((resolve, reject) => {
      const req = reqModule.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          // Both streams, interleaved in the order Podman wrote them — the
          // caller asked for stdout *and* stderr and renders one text blob.
          const { stdout, stderr } = demultiplexExecStream(Buffer.concat(chunks));
          resolve(stderr ? stdout + stderr : stdout);
        });
        res.on('error', reject);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Podman API request timed out: GET container logs`));
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

    // `timeoutMs: null` — a followed log stream is idle by design between
    // lines, so a socket inactivity timeout would kill exactly the sessions
    // that are working. The caller closes it via the returned `abort`.
    const { module: reqModule, options: reqOptions } = this.plan(
      `/containers/${id}/logs?${params}`,
      'GET',
      { headers: { Connection: 'keep-alive' }, timeoutMs: null },
    );

    const req = reqModule.request(reqOptions, (res) => {
      const emitLines = (payload: Buffer) => {
        for (const line of payload.toString('utf-8').split('\n')) {
          if (line) onData(line);
        }
      };

      // Both streams go to the same callback: the caller renders one log view
      // and asked for stdout and stderr together.
      const read = createFrameReader({ tty: false, onStdout: emitLines, onStderr: emitLines });

      res.on('data', read);
      res.on('end', onEnd);
      res.on('error', onError);
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

    const body = JSON.stringify({ Detach: false, Tty: tty });
    // No timeout: an interactive session is idle whenever the user is thinking.
    const { module: reqModule, options: reqOptions } = this.plan(
      `/exec/${execId}/start`,
      'POST',
      {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
        timeoutMs: null,
      },
    );

    return new Promise<ExecStream>((resolve, reject) => {
      const req = reqModule.request(reqOptions);

      let settled = false;
      const handlers = {
        stdout: [] as Array<(d: Buffer) => void>,
        stderr: [] as Array<(d: Buffer) => void>,
        end: [] as Array<() => void>,
      };

      const emitEnd = () => {
        for (const fn of handlers.end.splice(0)) fn();
      };

      const attach = (socket: import('net').Socket, head: Buffer) => {
        if (settled) return;
        settled = true;
        const read = createFrameReader({
          tty,
          onStdout: (payload) => { for (const fn of handlers.stdout) fn(payload); },
          onStderr: (payload) => { for (const fn of handlers.stderr) fn(payload); },
        });
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

    const body = JSON.stringify({ Detach: false, Tty: tty });
    // No timeout: a long-running command is silent while it works.
    const { module: reqModule, options: reqOptions } = this.plan(
      `/exec/${execId}/start`,
      'POST',
      {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeoutMs: null,
      },
    );

    const handlers = {
      stdout: [] as Array<(d: Buffer) => void>,
      stderr: [] as Array<(d: Buffer) => void>,
      end: [] as Array<() => void>,
    };
    const emitEnd = () => { for (const fn of handlers.end.splice(0)) fn(); };

    const read = createFrameReader({
      tty,
      onStdout: (payload) => { for (const fn of handlers.stdout) fn(payload); },
      onStderr: (payload) => { for (const fn of handlers.stderr) fn(payload); },
    });

    return new Promise<ExecStream>((resolve, reject) => {
      const req = reqModule.request(reqOptions);

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

    // Step 2: Start exec and capture output. No timeout — the command decides
    // how long it takes, and the caller decides whether to wait.
    const { module: reqModule, options: reqOptions } = this.plan(
      `/exec/${execId}/start`,
      'POST',
      { headers: { 'Content-Type': 'application/json' }, timeoutMs: null },
    );

    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
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

export function createPodmanClient(config: PodmanConfig): PodmanClient {
  return new PodmanClient(config);
}
