/**
 * SSH helpers for worker provisioning and the host terminal.
 *
 * Commands are executed via `spawn` with an argv array and no shell, so the
 * local shell never interprets user input.  (A previous implementation
 * interpolated the command into an `execSync` string, which let `$(...)` in a
 * terminal command execute on the Rudder host rather than the worker.)
 *
 * Everything here is async — `execSync` would block the single-threaded server
 * for the whole timeout window, freezing every other request.
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';
import { randomBytes } from 'crypto';
import { resolveDataDir } from './paths';
import { hostnameFormatError, sshUserFormatError } from './ssh-target';

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

/** Persistent known_hosts so a worker's key is pinned after first contact. */
const KNOWN_HOSTS_PATH = (() => {
  const dir = resolveDataDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return join(tmpdir(), 'rudder_known_hosts');
  }
  return join(dir, 'known_hosts');
})();

/**
 * Base SSH options.
 *
 * `accept-new` trusts a host the first time it is seen and pins it thereafter,
 * so an attacker cannot transparently swap in a different worker later.  It is
 * still trust-on-first-use; `StrictHostKeyChecking=no` (the previous setting)
 * accepted *any* changed key on *every* connection.
 */
function baseOptions(port: number, keyPath: string): string[] {
  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    // Suppress the "Permanently added ... to the list of known hosts" notice,
    // which would otherwise surface as spurious stderr on first connection.
    '-o', 'LogLevel=ERROR',
    '-i', keyPath,
    '-p', String(port),
  ];
}

export function createTempKeyFile(privateKey: string): string {
  // Random name: a predictable path in a shared tmpdir invites a symlink race.
  const tempPath = join(tmpdir(), `rudder_${randomBytes(16).toString('hex')}.key`);
  writeFileSync(tempPath, privateKey, { mode: 0o600, flag: 'wx' });
  return platform() === 'win32' ? tempPath.replace(/\\/g, '/') : tempPath;
}

export function deleteTempKeyFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/**
 * The `user@host` argument, checked before it becomes one.
 *
 * argv rather than a shell string already keeps `$(...)` out of the local shell
 * — but not a value that begins with a dash. `ssh` takes no `--` before its
 * destination, so `-oProxyCommand=curl…|sh` in either half is parsed as an
 * option and runs on *this* host, as the Rudder process, before any connection
 * is attempted.
 *
 * Checked here and not only where a worker is created, because rows written
 * before the create and edit forms validated these fields are still in the
 * database, and this is the last point at which either value is still data.
 */
function sshDestination(username: string, host: string): string {
  const problem = sshUserFormatError(username) ?? hostnameFormatError(host);
  if (problem) {
    throw new Error(`Refusing to connect: ${problem}`);
  }
  return `${username.trim()}@${host.trim()}`;
}

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run ssh with an argv array. Never invokes a shell locally. */
function runSSH(
  args: string[],
  opts: { timeoutMs: number; input?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { shell: false });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        stdout,
        stderr: stderr || `SSH command timed out after ${opts.timeoutMs}ms`,
        exitCode: 124,
      });
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    if (opts.input !== undefined) {
      child.stdin.on('error', () => { /* remote closed early */ });
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function testSSHConnection(config: SSHConnectionConfig): Promise<boolean> {
  let tempKeyPath: string | null = null;
  try {
    const destination = sshDestination(config.username, config.host);
    tempKeyPath = createTempKeyFile(config.privateKey);
    const result = await runSSH(
      [
        ...baseOptions(config.port, tempKeyPath),
        '-o', 'ConnectTimeout=10',
        destination,
        'echo hello',
      ],
      { timeoutMs: 15000 },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  } finally {
    // The old implementation only deleted the key on success, leaving private
    // keys in tmpdir whenever a connection test failed.
    if (tempKeyPath) deleteTempKeyFile(tempKeyPath);
  }
}

export async function executeSSHCommand(
  config: SSHConnectionConfig,
  command: string,
  stdinInput?: string,
): Promise<RunResult> {
  let tempKeyPath: string | null = null;
  try {
    // Before the key file exists, so a rejected destination leaves nothing behind.
    const destination = sshDestination(config.username, config.host);
    tempKeyPath = createTempKeyFile(config.privateKey);

    const args = [
      ...baseOptions(config.port, tempKeyPath),
      '-o', 'ConnectTimeout=30',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=60',
      destination,
      // Passed as a single argv element: the *remote* shell interprets it,
      // the local one never sees it.
      command,
    ];

    return await runSSH(args, {
      timeoutMs: stdinInput ? 900_000 : 120_000,
      input: stdinInput,
    });
  } catch (error: any) {
    return { stdout: '', stderr: error?.message || 'SSH execution failed', exitCode: 1 };
  } finally {
    if (tempKeyPath) deleteTempKeyFile(tempKeyPath);
  }
}
