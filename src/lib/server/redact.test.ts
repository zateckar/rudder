import { describe, expect, test } from 'bun:test';
import { redactArgs, redactContainerInspect, redactEnv } from './redact';

describe('redactEnv', () => {
  test('masks the value and keeps the name', () => {
    expect(redactEnv(['DATABASE_URL=postgres://u:p@h/db'])).toEqual([
      'DATABASE_URL=***REDACTED***',
    ]);
  });

  test('masks names no secret-detecting pattern would flag', () => {
    // The point of the allowlist: none of these read as sensitive.
    expect(redactEnv(['SMTP_HOST=mail.internal', 'S3_BUCKET=x', 'ADMIN_EMAIL=a@b.c'])).toEqual([
      'SMTP_HOST=***REDACTED***',
      'S3_BUCKET=***REDACTED***',
      'ADMIN_EMAIL=***REDACTED***',
    ]);
  });

  test('leaves inert variables readable', () => {
    expect(redactEnv(['PATH=/usr/bin', 'NODE_ENV=production'])).toEqual([
      'PATH=/usr/bin',
      'NODE_ENV=production',
    ]);
  });

  test('passes through an entry with no value', () => {
    expect(redactEnv(['JUST_A_NAME'])).toEqual(['JUST_A_NAME']);
  });

  test('an empty value is still masked, so its emptiness is not disclosed', () => {
    expect(redactEnv(['API_KEY='])).toEqual(['API_KEY=***REDACTED***']);
  });
});

describe('redactArgs', () => {
  test('masks an inline flag value', () => {
    expect(redactArgs(['serve', '--api-key=abc123'])).toEqual(['serve', '--api-key=***REDACTED***']);
  });

  test('masks the argument after a bare secret flag', () => {
    expect(redactArgs(['mysql', '--password', 'hunter2', '--host', 'db'])).toEqual([
      'mysql',
      '--password',
      '***REDACTED***',
      '--host',
      'db',
    ]);
  });

  test('leaves an ordinary command legible', () => {
    expect(redactArgs(['node', 'server.js', '--port=3000'])).toEqual([
      'node',
      'server.js',
      '--port=3000',
    ]);
  });

  test('a value that looks like a flag is still consumed as the value', () => {
    expect(redactArgs(['--token', '--not-a-flag'])).toEqual(['--token', '***REDACTED***']);
  });
});

describe('redactContainerInspect', () => {
  const inspect = {
    Id: 'abc',
    State: { Running: true },
    Config: {
      Image: 'nginx',
      Env: ['SECRET=s3cr3t', 'PATH=/usr/bin'],
      Cmd: ['app', '--token=t'],
      Entrypoint: ['/entry.sh'],
      Labels: { a: 'b' },
    },
  };

  test('masks Config.Env, Cmd and Entrypoint', () => {
    const out = redactContainerInspect(inspect) as any;
    expect(out.Config.Env).toEqual(['SECRET=***REDACTED***', 'PATH=/usr/bin']);
    expect(out.Config.Cmd).toEqual(['app', '--token=***REDACTED***']);
    expect(out.Config.Entrypoint).toEqual(['/entry.sh']);
  });

  test('leaves everything else alone', () => {
    const out = redactContainerInspect(inspect) as any;
    expect(out.Id).toBe('abc');
    expect(out.State).toEqual({ Running: true });
    expect(out.Config.Image).toBe('nginx');
    expect(out.Config.Labels).toEqual({ a: 'b' });
  });

  test('does not mutate the input', () => {
    // `/api/containers/[id]/recreate` feeds the same Config.Env back into
    // createContainer; mutating here would recreate the container with the
    // literal redaction marker as every secret it has.
    redactContainerInspect(inspect);
    expect(inspect.Config.Env).toEqual(['SECRET=s3cr3t', 'PATH=/usr/bin']);
    expect(inspect.Config.Cmd).toEqual(['app', '--token=t']);
  });

  test('tolerates an inspect with no Config', () => {
    expect(redactContainerInspect({ Id: 'x' })).toEqual({ Id: 'x' });
    expect(redactContainerInspect(null)).toBe(null);
  });
});
