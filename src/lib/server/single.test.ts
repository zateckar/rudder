import { describe, expect, test } from 'bun:test';
import { ManifestError, type PlanContext } from './deploy/plan';
import { parseEnvironment, parseSingle, parseSingleConfig } from './single';

/** Deterministic allocator so port assignment is assertable. */
function sequentialPorts(start = 31000) {
  let next = start;
  return () => next++;
}

/** Slices to `abcdef12`, which is what appears in generated names. */
const APP_ID = 'abcdef1234567890';

function parse(manifest: string, options: Partial<PlanContext> = {}) {
  return parseSingle(manifest, {
    appId: APP_ID,
    appName: 'shop',
    allocatePort: sequentialPorts(),
    ...options,
  }).containers;
}

describe('parseSingleConfig', () => {
  test('reads the JSON the application form writes', () => {
    expect(parseSingleConfig('{"image":"nginx:1.27","command":"nginx -g daemon off;"}')).toEqual({
      image: 'nginx:1.27',
      command: 'nginx -g daemon off;',
    });
  });

  test('accepts a bare image reference', () => {
    // The oldest applications stored the image and nothing else.
    expect(parseSingleConfig('nginx')).toEqual({ image: 'nginx' });
  });

  test('refuses JSON that carries no image, rather than using the blob as one', () => {
    // This used to return { image: '{"ports":[]}' }, which reached Podman and
    // came back as "invalid reference format" — a 500 describing a string the
    // user never typed.
    expect(() => parseSingleConfig('{"ports":[]}')).toThrow(/no image to deploy/i);
    expect(() => parseSingleConfig('{"image":"","ports":[]}')).toThrow(/no image to deploy/i);
    expect(() => parseSingleConfig('{"image":"   "}')).toThrow(/no image to deploy/i);
  });

  test('an empty manifest is refused, not turned into an empty image', () => {
    expect(() => parseSingleConfig('')).toThrow(/no image to deploy/i);
    expect(() => parseSingleConfig('   ')).toThrow(/no image to deploy/i);
  });

  test('still accepts a JSON-quoted bare reference', () => {
    expect(parseSingleConfig('"nginx:alpine"')).toEqual({ image: 'nginx:alpine' });
  });
});

describe('parseSingle', () => {
  test('plans one container with the application name', () => {
    const [c] = parse('nginx');
    expect(c.name).toBe('shop-abcdef12');
    expect(c.image).toBe('nginx');
    expect(c.key).toBe('shop');
  });

  test('assumes a web application on 80 when no port is declared', () => {
    const [c] = parse('nginx', { baseDomain: 'apps.example.com' });
    expect(c.ports).toEqual({ '80/tcp': [{ hostPort: '31000' }] });
    expect(c.route).toMatchObject({ domain: 'shop.apps.example.com', hostPort: 31000 });
  });

  test('honours an explicit host port for a single replica', () => {
    // The user asked for that number and something outside Rudder may rely on
    // it — a firewall rule, a monitoring probe.
    const manifest = JSON.stringify({
      image: 'nginx',
      ports: [{ containerPort: '80', hostPort: '8080', protocol: 'tcp' }],
    });
    const [c] = parse(manifest);
    expect(c.ports['80/tcp']).toEqual([{ hostPort: '8080' }]);
  });

  test('allocates instead when there is more than one replica', () => {
    // Two containers cannot hold one host port, so the explicit request has to
    // give way rather than fail the second replica at bind time.
    const manifest = JSON.stringify({
      image: 'nginx',
      ports: [{ containerPort: '80', hostPort: '8080', protocol: 'tcp' }],
    });
    const containers = parse(manifest, { replicas: 2 });
    const ports = containers.map((c) => c.ports['80/tcp'][0].hostPort);
    expect(ports).toEqual(['31000', '31001']);
  });

  test('names replicas apart and gives them one alias', () => {
    const containers = parse('nginx', { replicas: 3 });
    expect(containers.map((c) => c.name)).toEqual([
      'shop-abcdef12-1',
      'shop-abcdef12-2',
      'shop-abcdef12-3',
    ]);
    // One name for the set, so a sibling resolving it round-robins.
    for (const c of containers) expect(c.aliases).toEqual(['shop']);
  });

  test('puts every replica behind one router', () => {
    // Assigning a route per replica would disambiguate them as separate
    // hostnames, which is the opposite of load balancing.
    const containers = parse('nginx', { replicas: 3, baseDomain: 'apps.example.com' });
    expect(new Set(containers.map((c) => c.route!.domain)).size).toBe(1);
    expect(containers.map((c) => c.route!.definesRouter)).toEqual([true, false, false]);
    // Each still advertises its own address.
    expect(containers.map((c) => c.route!.hostPort)).toEqual([31000, 31001, 31002]);
  });

  test('caps replicas at ten', () => {
    expect(parse('nginx', { replicas: 99 })).toHaveLength(10);
    expect(parse('nginx', { replicas: 0 })).toHaveLength(1);
  });

  test('splits the command on whitespace', () => {
    const [c] = parse(JSON.stringify({ image: 'nginx', command: '  sleep   30 ' }));
    expect(c.command).toEqual(['sleep', '30']);
  });

  test('parses resource limits', () => {
    const [c] = parse(JSON.stringify({ image: 'nginx', memoryLimit: '512m', cpuLimit: '0.5' }));
    expect(c.memory).toBe(512 * 1024 * 1024);
    expect(c.cpuQuota).toBe(50000);
    expect(c.cpuPeriod).toBe(100000);
  });

  test('refuses an application configured to build from git', () => {
    // Git builds needed a server-held SSH key, which no longer exists.
    expect(() => parse('nginx', { gitRepo: 'git@example.com:team/app.git' })).toThrow(ManifestError);
  });

  test('refuses an empty manifest rather than deploying nothing', () => {
    expect(() => parse('   ')).toThrow(/no image/);
  });
});

describe('parseEnvironment', () => {
  test('renders the form JSON as KEY=value', () => {
    const raw = JSON.stringify([{ key: 'A', value: '1' }, { key: 'B', value: '' }]);
    expect(parseEnvironment(raw)).toEqual(['A=1', 'B=']);
  });

  test('drops entries with a blank key', () => {
    const raw = JSON.stringify([{ key: '  ', value: '1' }, { key: 'B', value: '2' }]);
    expect(parseEnvironment(raw)).toEqual(['B=2']);
  });

  test('survives an unusable column', () => {
    expect(parseEnvironment(null)).toEqual([]);
    expect(parseEnvironment('{not json')).toEqual([]);
    expect(parseEnvironment('{"a":1}')).toEqual([]);
  });
});
