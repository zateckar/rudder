import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runtimeIntentHelperCommand } from './runtime-policy';

const bash = process.platform === 'win32'
  ? [join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe'),
      join(process.env.SCOOP ?? join(process.env.USERPROFILE ?? '', 'scoop'), 'apps/git/current/bin/bash.exe'),
      resolve(dirname(Bun.which('git') ?? ''), '../apps/git/current/bin/bash.exe')].find(existsSync) ?? ''
  : '/bin/bash';

test.skipIf(!existsSync(bash))('runtime helper atomically installs the current guard before confirming stopped intent', () => {
  const directory = mkdtempSync(join(process.platform === 'win32' ? process.cwd() : tmpdir(), '.rudder-guard-install-'));
  const bin = join(directory, 'bin');
  const lib = join(directory, 'lib');
  mkdirSync(bin); mkdirSync(lib);
  try {
    writeFileSync(join(bin, 'rudder-container-boot.sh'), 'old unsafe guard\n');
    const command = runtimeIntentHelperCommand('container0123', 'stopped');
    const shellPath = (path: string) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const script = command[2].replaceAll('/rudder-host-bin', shellPath(bin))
      .replaceAll('/rudder-var-lib', shellPath(lib));
    execFileSync(bash, ['-c', script, ...command.slice(3)]);
    expect(readFileSync(join(bin, 'rudder-container-boot.sh'), 'utf8')).toBe(
      readFileSync(resolve('src/lib/server/provisioning/shell/scripts/rudder-container-boot.sh'), 'utf8'));
    expect(readFileSync(join(lib, 'rudder/runtime-intent/container0123'), 'utf8')).toBe('stopped\n');
    if (process.platform !== 'win32') expect(statSync(join(bin, 'rudder-container-boot.sh')).mode & 0o777).toBe(0o755);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.skipIf(!existsSync(bash))('worker boot replays only running intent and preserves unrelated workloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rudder-boot-policy-'));
  const normalized = directory.replaceAll('\\', '/');
  const podman = join(directory, 'podman.sh');
  const log = join(directory, 'started.log');
  try {
    writeFileSync(podman, `#!/bin/bash
case "$1" in
  ps) [[ "$*" == *restart-policy=always* ]] && printf '%s\\n' active stopped retained pending foreign adopted ;;
  inspect) [[ "\${@: -1}" == foreign || "\${@: -1}" == adopted ]] && echo false || echo true ;;
  start) echo "$2" >> "$BOOT_LOG" ;;
esac
exit 0
`);
    writeFileSync(join(directory, 'active'), 'running\n');
    writeFileSync(join(directory, 'stopped'), 'stopped\n');
    writeFileSync(join(directory, 'retained'), 'stopped\n');
    writeFileSync(join(directory, 'adopted'), 'stopped\n');
    // Give the stub an executable mode so both Linux and Git Bash can run it.
    const executable = join(directory, 'podman');
    writeFileSync(executable, readFileSync(podman), { mode: 0o755 });
    execFileSync(bash, [resolve('src/lib/server/provisioning/shell/scripts/rudder-container-boot.sh').replaceAll('\\', '/'), 'start'], {
      env: { ...process.env, PODMAN: executable.replaceAll('\\', '/'), RUNTIME_INTENT_DIR: normalized, BOOT_LOG: log.replaceAll('\\', '/') },
    });
    expect(readFileSync(log, 'utf8').trim().split(/\r?\n/)).toEqual(['active', 'foreign']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
