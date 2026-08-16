import { describe, expect, test } from 'bun:test';
import { REDACTED, isSecretLabel, redactProvisioningOutput, redactSecretLabels } from './redaction';

describe('isSecretLabel', () => {
  test('recognises the OIDC plugin credentials', () => {
    const p = 'traefik.http.middlewares.app-oidc.plugin.traefik-oidc-auth';
    expect(isSecretLabel(`${p}.Secret`)).toBe(true);
    expect(isSecretLabel(`${p}.Provider.ClientSecret`)).toBe(true);
  });

  test('leaves ordinary routing labels alone', () => {
    expect(isSecretLabel('traefik.http.routers.app-secure.rule')).toBe(false);
    expect(isSecretLabel('traefik.enable')).toBe(false);
    expect(isSecretLabel('rudder.team.id')).toBe(false);
    // Substring, not leaf: this identifies the client, it is not the secret.
    expect(isSecretLabel(`traefik.http.middlewares.a.plugin.x.Provider.ClientId`)).toBe(false);
  });

  test('matches case-insensitively, since the plugin namespace is capitalised', () => {
    expect(isSecretLabel('some.path.secret')).toBe(true);
    expect(isSecretLabel('some.path.SECRET')).toBe(true);
  });
});

describe('redactSecretLabels', () => {
  const labels = {
    'traefik.enable': 'true',
    'traefik.http.routers.app-secure.rule': 'Host(`app.example.com`)',
    'traefik.http.middlewares.app-oidc.plugin.traefik-oidc-auth.Secret': 'abcdefghijklmnopqrstuvwxyz012345',
    'traefik.http.middlewares.app-oidc.plugin.traefik-oidc-auth.Provider.ClientSecret': 'super-secret-value',
    'app': 'demo',
  };

  test('replaces credential values and keeps the keys', () => {
    const out = redactSecretLabels(labels);
    expect(out['traefik.http.middlewares.app-oidc.plugin.traefik-oidc-auth.Secret']).toBe(REDACTED);
    expect(out['traefik.http.middlewares.app-oidc.plugin.traefik-oidc-auth.Provider.ClientSecret']).toBe(REDACTED);
    expect(Object.keys(out).sort()).toEqual(Object.keys(labels).sort());
  });

  test('leaves everything else untouched', () => {
    const out = redactSecretLabels(labels);
    expect(out['traefik.http.routers.app-secure.rule']).toBe('Host(`app.example.com`)');
    expect(out['app']).toBe('demo');
  });

  test('does not mutate the input, which is still sent to Podman', () => {
    const original = { ...labels };
    redactSecretLabels(labels);
    expect(labels).toEqual(original);
  });

  test('no secret value survives anywhere in the output', () => {
    const serialised = JSON.stringify(redactSecretLabels(labels));
    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });
});

describe('redactProvisioningOutput', () => {
  test('masks the mTLS client key and the bouncer key', () => {
    const output = [
      '=== Starting worker provisioning for alpha ===',
      'CA_CERT_B64=LS0tLS1CRUdJTiBDRVJU',
      'CLIENT_CERT_B64=LS0tLS1CRUdJTiBDRVJU',
      'CLIENT_KEY_B64=LS0tLS1CRUdJTiBQUklWQVRF',
      'BOUNCER_KEY=abc123def456',
      'Provisioning complete',
    ].join('\n');

    const out = redactProvisioningOutput(output);
    expect(out).toContain(`CLIENT_KEY_B64=${REDACTED}`);
    expect(out).toContain(`BOUNCER_KEY=${REDACTED}`);
    expect(out).not.toContain('LS0tLS1CRUdJTiBQUklWQVRF');
    expect(out).not.toContain('abc123def456');
  });

  test('keeps the surrounding log readable', () => {
    const out = redactProvisioningOutput('STEP_DONE:podman\nBOUNCER_KEY=x\nSTEP_DONE:traefik');
    expect(out).toContain('STEP_DONE:podman');
    expect(out).toContain('STEP_DONE:traefik');
  });

  test('masks an inline PEM private key', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nsecretline\n-----END RSA PRIVATE KEY-----';
    const out = redactProvisioningOutput(`before\n${pem}\nafter`);
    expect(out).not.toContain('secretline');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  test('collapses each key separately rather than swallowing the text between two', () => {
    const two =
      '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n' +
      'KEEP THIS LINE\n' +
      '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----';
    const out = redactProvisioningOutput(two);
    expect(out).toContain('KEEP THIS LINE');
    expect(out).not.toContain('AAA');
    expect(out).not.toContain('BBB');
  });

  test('output with nothing sensitive is unchanged', () => {
    const plain = 'STEP_DONE:firewall\nExposed: 22, 443';
    expect(redactProvisioningOutput(plain)).toBe(plain);
  });
});
