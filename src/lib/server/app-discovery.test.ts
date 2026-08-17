import { describe, expect, test } from 'bun:test';
import {
  environmentFromContainer,
  isInfrastructureContainer,
  proposedAppName,
  restartPolicyFromContainer,
  routedDomain,
  volumesFromContainer,
} from './app-discovery';
import type { ContainerInspect } from './podman';

function inspect(over: Record<string, any> = {}): ContainerInspect {
  return {
    Id: 'abc123',
    Name: '/whoami',
    Config: { Image: 'traefik/whoami:latest', Labels: {}, Env: [] },
    State: { Status: 'running' },
    ...over,
  } as unknown as ContainerInspect;
}

describe('isInfrastructureContainer', () => {
  test('recognises the platform containers Rudder runs itself', () => {
    expect(isInfrastructureContainer({ Names: ['/traefik'] })).toBe(true);
    expect(isInfrastructureContainer({ Names: ['/crowdsec'] })).toBe(true);
    expect(isInfrastructureContainer({ Names: ['/podman-api'] })).toBe(true);
  });

  test('leaves applications alone', () => {
    expect(isInfrastructureContainer({ Names: ['/shop-1a2b3c4d'] })).toBe(false);
    expect(isInfrastructureContainer({ Names: [] })).toBe(false);
  });
});

describe('routedDomain', () => {
  test('reads the hostname out of a router rule', () => {
    // The one thing the old label parsing did that was not a guess: a Host()
    // rule names a hostname and there is nothing to infer.
    expect(
      routedDomain({ 'traefik.http.routers.shop-secure.rule': 'Host(`shop.example.com`)' }),
    ).toBe('shop.example.com');
  });

  test('handles a rule with more than one matcher', () => {
    expect(
      routedDomain({
        'traefik.http.routers.shop.rule': 'Host(`shop.example.com`) && PathPrefix(`/api`)',
      }),
    ).toBe('shop.example.com');
  });

  test('is null when the container is not routed', () => {
    expect(routedDomain({})).toBeNull();
    expect(routedDomain(undefined)).toBeNull();
    // A database or a queue has no router, and is still worth adopting — the old
    // code required a router label and silently skipped every one of them.
    expect(routedDomain({ app: 'postgres' })).toBeNull();
  });

  test('does not invent a domain from a rule it cannot read', () => {
    expect(routedDomain({ 'traefik.http.routers.shop.rule': 'PathPrefix(`/api`)' })).toBeNull();
  });
});

describe('proposedAppName', () => {
  test('prefers the app label', () => {
    expect(proposedAppName('/shop-1a2b3c4d', { app: 'shop' })).toBe('shop');
  });

  test('recovers the name from a Rudder container name', () => {
    expect(proposedAppName('/shop-1a2b3c4d', {})).toBe('shop');
    expect(proposedAppName('shop-1a2b3c4d-web', {})).toBe('shop');
    // A name with a hyphen in it survives, which the old `.split('-')[0]` did
    // not: `hello-world-26ea60bc` used to become `hello`.
    expect(proposedAppName('/hello-world-26ea60bc', {})).toBe('hello-world');
  });

  test('falls back to the container name', () => {
    expect(proposedAppName('/postgres', {})).toBe('postgres');
    expect(proposedAppName('/my-queue', {})).toBe('my-queue');
  });

  test('ignores a blank app label', () => {
    expect(proposedAppName('/postgres', { app: '   ' })).toBe('postgres');
  });
});

describe('environmentFromContainer', () => {
  test('carries the configuration over', () => {
    const env = environmentFromContainer(
      inspect({ Config: { Image: 'x', Labels: {}, Env: ['LOG_LEVEL=debug', 'PORT=8080'] } }),
    );
    expect(JSON.parse(env!)).toEqual([
      { key: 'LOG_LEVEL', value: 'debug' },
      { key: 'PORT', value: '8080' },
    ]);
  });

  test('drops variables that came from the image', () => {
    // PATH and HOME are not configuration. Carrying them would make them look
    // like something the operator had set.
    const env = environmentFromContainer(
      inspect({ Config: { Image: 'x', Labels: {}, Env: ['PATH=/usr/bin', 'HOME=/root', 'A=1'] } }),
    );
    expect(JSON.parse(env!)).toEqual([{ key: 'A', value: '1' }]);
  });

  test('keeps a value containing an equals sign intact', () => {
    const env = environmentFromContainer(
      inspect({ Config: { Image: 'x', Labels: {}, Env: ['DSN=postgres://u:p@h/db?a=b'] } }),
    );
    expect(JSON.parse(env!)).toEqual([{ key: 'DSN', value: 'postgres://u:p@h/db?a=b' }]);
  });

  test('is null when there is nothing to carry', () => {
    expect(environmentFromContainer(inspect())).toBeNull();
    expect(environmentFromContainer(inspect({ Config: { Image: 'x', Labels: {} } }))).toBeNull();
  });
});

describe('volumesFromContainer', () => {
  test('reads the host mounts', () => {
    const volumes = volumesFromContainer(
      inspect({ HostConfig: { Binds: ['/srv/data:/data:rw', '/etc/conf:/conf:ro'] } }),
    );
    expect(JSON.parse(volumes!)).toEqual([
      { hostPath: '/srv/data', containerPath: '/data', mode: 'rw', volumeId: null },
      { hostPath: '/etc/conf', containerPath: '/conf', mode: 'ro', volumeId: null },
    ]);
  });

  test('defaults a bind with no mode to read-write', () => {
    const volumes = volumesFromContainer(inspect({ HostConfig: { Binds: ['/srv/data:/data'] } }));
    expect(JSON.parse(volumes!)[0].mode).toBe('rw');
  });

  test('is null when the container mounts nothing', () => {
    expect(volumesFromContainer(inspect())).toBeNull();
  });
});

describe('restartPolicyFromContainer', () => {
  test('carries a recognised policy over', () => {
    for (const name of ['always', 'on-failure', 'unless-stopped'] as const) {
      expect(restartPolicyFromContainer(inspect({ HostConfig: { RestartPolicy: { name } } }))).toBe('no');
      expect(restartPolicyFromContainer(inspect({ HostConfig: { RestartPolicy: { Name: name } } }))).toBe(name);
    }
  });

  test('defaults to no restart', () => {
    expect(restartPolicyFromContainer(inspect())).toBe('no');
    expect(restartPolicyFromContainer(inspect({ HostConfig: { RestartPolicy: { Name: 'weird' } } }))).toBe('no');
  });
});
