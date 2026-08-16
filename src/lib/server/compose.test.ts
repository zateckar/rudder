import { describe, expect, test } from 'bun:test';
import { parseCompose, topologicalOrder, validateCompose } from './compose';
import type { PlanContext } from './deploy/plan';

/** Deterministic allocator so port assignment is assertable. */
function sequentialPorts(start = 31000) {
  let next = start;
  return () => next++;
}

/** Slices to `abcdef12`, which is what appears in generated names. */
const APP_ID = 'abcdef1234567890';

function parse(manifest: string, options: Partial<PlanContext> = {}) {
  return parseCompose(manifest, {
    appId: APP_ID,
    appName: 'shop',
    allocatePort: sequentialPorts(),
    ...options,
  }).containers;
}

describe('network aliases', () => {
  test('gives every service its bare name and a qualified one', () => {
    const [web, db] = parse(`
services:
  web:
    image: nginx
  db:
    image: postgres
`);
    expect(web.aliases).toEqual(['web', 'shop-web']);
    expect(db.aliases).toEqual(['db', 'shop-db']);
  });

  test('records the bare alias as a label', () => {
    const [web] = parse(`
services:
  web:
    image: nginx
`);
    expect(web.labels['rudder.alias']).toBe('web');
  });

  test('refuses services whose names collapse to one DNS label', () => {
    expect(() => parse(`
services:
  my_db:
    image: postgres
  my-db:
    image: postgres
`)).toThrow(/both resolve to the network alias "my-db"/);
  });
});

describe('port notations', () => {
  const cases: Array<[string, string, string]> = [
    ['container only', '"8080"', '8080/tcp'],
    ['host:container', '"80:8080"', '8080/tcp'],
    ['ip:host:container', '"1.2.3.4:80:8080"', '8080/tcp'],
    ['protocol suffix', '"8080/udp"', '8080/udp'],
  ];

  for (const [name, entry, expected] of cases) {
    test(`parses ${name}`, () => {
      const [c] = parse(`
services:
  web:
    image: nginx
    ports: [${entry}]
`);
      expect(Object.keys(c.ports)).toEqual([expected]);
    });
  }

  test('parses the long form with target and protocol', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    ports:
      - target: 8080
        published: 80
        protocol: udp
`);
    expect(Object.keys(c.ports)).toEqual(['8080/udp']);
  });

  test('ignores the published port and uses the allocator instead', () => {
    // Host ports are an implementation detail — Traefik does the routing, and
    // honouring the compose file would let two apps fight over a port.
    const [c] = parse(`
services:
  web:
    image: nginx
    ports: ["80:8080"]
`, { allocatePort: sequentialPorts(31000) });
    expect(c.ports['8080/tcp']).toEqual([{ hostPort: '31000' }]);
  });

  test('skips unparseable port entries', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    ports: ["notaport"]
`);
    expect(Object.keys(c.ports)).toHaveLength(0);
  });
});

describe('host port allocation', () => {
  test('every service gets a distinct port from the injected allocator', () => {
    const containers = parse(`
services:
  a: { image: nginx, ports: ["80"] }
  b: { image: nginx, ports: ["80"] }
  c: { image: nginx, ports: ["80"] }
`, { allocatePort: sequentialPorts(31000) });

    const ports = containers.map((c) => c.ports['80/tcp'][0].hostPort);
    expect(ports).toEqual(['31000', '31001', '31002']);
    expect(new Set(ports).size).toBe(3);
  });

  test('a service exposing several ports draws one allocation each', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    ports: ["80", "443", "8080"]
`, { allocatePort: sequentialPorts(31000) });

    const assigned = Object.values(c.ports).map((b) => b[0].hostPort);
    expect(new Set(assigned).size).toBe(3);
  });
});

describe('volumes', () => {
  test('converts relative sources to deterministic named volumes', () => {
    // Relative paths cannot be bind-mounted on a remote worker; the name must
    // be stable so data survives redeployment.
    const [c] = parse(`
services:
  db:
    image: postgres
    volumes: ["./data:/var/lib/postgresql/data"]
`, { appId: 'abcdef1234567890' });

    expect(c.mounts).toEqual([
      {
        kind: 'volume',
        name: 'rudder-abcdef12-db-data',
        target: '/var/lib/postgresql/data',
        mode: 'rw',
      },
    ]);
  });

  test('converts home-relative sources too', () => {
    const [c] = parse(`
services:
  db: { image: postgres, volumes: ["~/data:/data"] }
`, { appId: 'abcdef1234567890' });
    expect(c.mounts[0]).toMatchObject({ kind: 'volume', name: 'rudder-abcdef12-db-data' });
  });

  test('keeps absolute paths as bind mounts', () => {
    const [c] = parse(`
services:
  db: { image: postgres, volumes: ["/srv/data:/data:ro"] }
`);
    expect(c.mounts).toEqual([
      { kind: 'bind', source: '/srv/data', target: '/data', mode: 'ro' },
    ]);
  });

  test('keeps named volumes as-is', () => {
    const [c] = parse(`
services:
  db: { image: postgres, volumes: ["pgdata:/data"] }
`);
    expect(c.mounts).toEqual([
      { kind: 'volume', name: 'pgdata', target: '/data', mode: 'rw' },
    ]);
  });

  test('honours read_only in the long form', () => {
    const [c] = parse(`
services:
  db:
    image: postgres
    volumes:
      - source: /srv/data
        target: /data
        read_only: true
`);
    expect(c.mounts[0]).toMatchObject({ mode: 'ro' });
  });

  test('keeps two mounts from one source rather than collapsing them', () => {
    // The old representation was keyed by source, so a source mounted at two
    // paths lost one of them without saying anything.
    const [c] = parse(`
services:
  db: { image: postgres, volumes: ["shared:/a", "shared:/b"] }
`);
    expect(c.mounts.map((m) => m.target)).toEqual(['/a', '/b']);
  });
});

describe('label sanitisation', () => {
  test('strips user-supplied traefik.* labels', () => {
    // Otherwise a tenant could point another tenant's hostname at their own
    // container by declaring a router rule in their compose file.
    const [c] = parse([
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      traefik.http.routers.evil.rule: "Host(`victim.example.com`)"',
      '      TRAEFIK.enable: "true"',
      '      my.label: keep-me',
    ].join('\n'));

    expect(c.labels['my.label']).toBe('keep-me');
    const userTraefik = Object.keys(c.labels).filter(
      (k) => k.toLowerCase().startsWith('traefik.') && k.includes('evil')
    );
    expect(userTraefik).toHaveLength(0);
    expect(c.labels['TRAEFIK.enable']).toBeUndefined();
  });

  test('applies team and stack labels', () => {
    const [c] = parse(`
services:
  web: { image: nginx }
`, {
      teamSlug: 'platform',
      team: { name: 'Platform', id: 'team-1' },
      stack: { name: 'Core', id: 'stack-1' },
    });

    expect(c.labels.team).toBe('platform');
    expect(c.labels['rudder.team.id']).toBe('team-1');
    expect(c.labels['rudder.stack.id']).toBe('stack-1');
  });
});

describe('hostname assignment', () => {
  test('the first port-exposing service owns the application hostname', () => {
    const containers = parse(`
services:
  web: { image: nginx, ports: ["80"] }
  api: { image: nginx, ports: ["80"] }
`, { baseDomain: 'apps.example.com' });

    expect(containers[0].route).toMatchObject({
      domain: 'shop.apps.example.com',
      routerName: 'shop',
      definesRouter: true,
    });
    expect(containers[1].route).toMatchObject({
      domain: 'shop-api.apps.example.com',
      routerName: 'shop-api',
    });
  });

  test('no two services share a hostname', () => {
    // Duplicate rules produce two Traefik routers and arbitrary resolution.
    const containers = parse(`
services:
  a: { image: nginx, ports: ["80"] }
  b: { image: nginx, ports: ["80"] }
  c: { image: nginx, ports: ["80"] }
`, { baseDomain: 'apps.example.com' });

    const domains = containers.map((c) => c.route!.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  test('an explicit app domain overrides the primary hostname only', () => {
    const containers = parse(`
services:
  web: { image: nginx, ports: ["80"] }
  api: { image: nginx, ports: ["80"] }
`, { baseDomain: 'apps.example.com', appDomain: 'custom.example.com' });

    expect(containers[0].route?.domain).toBe('custom.example.com');
    expect(containers[1].route?.domain).toBe('shop-api.apps.example.com');
  });

  test('the route names the allocated host port, not the declared one', () => {
    const [c] = parse(`
services:
  web: { image: nginx, ports: ["8080:80"] }
`, { baseDomain: 'apps.example.com' });
    expect(c.route?.hostPort).toBe(31000);
  });

  test('services without ports get no route', () => {
    const [c] = parse(`
services:
  worker: { image: nginx }
`, { baseDomain: 'apps.example.com' });
    expect(c.route).toBeUndefined();
  });

  test('nothing is routed without a base domain', () => {
    const [c] = parse(`
services:
  web: { image: nginx, ports: ["80"] }
`);
    expect(c.route).toBeUndefined();
  });
});

describe('healthcheck', () => {
  test('wraps the shell form as CMD-SHELL', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    healthcheck:
      test: curl -f http://localhost/health
      interval: 30s
      timeout: 5s
      retries: 3
`);
    expect(c.healthcheck?.test).toEqual(['CMD-SHELL', 'curl -f http://localhost/health']);
    expect(c.healthcheck?.interval).toBe(30_000_000_000);
    expect(c.healthcheck?.retries).toBe(3);
  });

  test('passes the list form through', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    healthcheck:
      test: ["CMD", "true"]
`);
    expect(c.healthcheck?.test).toEqual(['CMD', 'true']);
  });
});

describe('depends_on ordering', () => {
  test('starts a dependency before its dependent, whatever the key order', () => {
    const containers = parse(`
services:
  web:
    image: nginx
    depends_on: [db]
  db:
    image: postgres
`);
    expect(containers.map((c) => c.key)).toEqual(['db', 'web']);
  });

  test('supports the condition-map form', () => {
    const containers = parse(`
services:
  web:
    image: nginx
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres
`);
    expect(containers.map((c) => c.key)).toEqual(['db', 'web']);
  });

  test('handles a chain', () => {
    const containers = parse(`
services:
  c: { image: nginx, depends_on: [b] }
  a: { image: nginx }
  b: { image: nginx, depends_on: [a] }
`);
    expect(containers.map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });

  test('ignores dependencies on services not in the file', () => {
    const containers = parse(`
services:
  web: { image: nginx, depends_on: [missing] }
`);
    expect(containers.map((c) => c.name)).toEqual(['shop-abcdef12-web']);
  });

  test('does not let start order steal the application hostname', () => {
    // `web` is declared first and is the public face of the stack, but it
    // depends on `db`, so the topological walk starts `db` first. The hostname
    // must still follow declaration order — otherwise sorting the parse loop
    // silently moves shop.example.com onto the database.
    const containers = parse(
      `
services:
  web:
    image: nginx
    depends_on: [db]
    ports: ["80"]
  db:
    image: postgres
    ports: ["5432"]
`,
      { baseDomain: 'example.com' },
    );

    expect(containers.map((c) => c.key)).toEqual(['db', 'web']);

    const hostOf = (key: string) => containers.find((c) => c.key === key)!.route!.domain;
    expect(hostOf('web')).toBe('shop.example.com');
    expect(hostOf('db')).toBe('shop-db.example.com');
  });

  test('throws on a cycle rather than ordering arbitrarily', () => {
    expect(() => parse(`
services:
  a: { image: nginx, depends_on: [b] }
  b: { image: nginx, depends_on: [a] }
`)).toThrow(/Circular depends_on/);
  });
});

describe('topologicalOrder', () => {
  test('reports the cycle members', () => {
    const result = topologicalOrder({
      a: { depends_on: ['b'] },
      b: { depends_on: ['c'] },
      c: { depends_on: ['a'] },
    });
    expect('cycle' in result).toBe(true);
    if ('cycle' in result) {
      expect(result.cycle).toContain('a');
      expect(result.cycle).toContain('b');
      expect(result.cycle).toContain('c');
    }
  });

  test('handles a service with no dependencies at all', () => {
    expect(topologicalOrder({ a: {}, b: {} })).toEqual({ order: ['a', 'b'] });
  });

  test('does not duplicate a shared dependency', () => {
    const result = topologicalOrder({
      a: { depends_on: ['db'] },
      b: { depends_on: ['db'] },
      db: {},
    });
    if ('order' in result) {
      expect(result.order).toEqual(['db', 'a', 'b']);
    }
  });
});

describe('validateCompose', () => {
  test('accepts a minimal file', () => {
    expect(validateCompose('services:\n  web:\n    image: nginx\n').valid).toBe(true);
  });

  test('rejects a file with no services', () => {
    expect(validateCompose('version: "3"\n').errors).toContain('No services defined');
  });

  test('rejects a service with neither image nor build', () => {
    const { errors } = validateCompose('services:\n  web:\n    ports: ["80"]\n');
    expect(errors.some((e) => e.includes('no image or build'))).toBe(true);
  });

  test('reports a depends_on typo instead of silently ignoring it', () => {
    const { errors } = validateCompose(`
services:
  web: { image: nginx, depends_on: [databse] }
  database: { image: postgres }
`);
    expect(errors.some((e) => e.includes('"databse"'))).toBe(true);
  });

  test('reports a dependency cycle', () => {
    const { errors } = validateCompose(`
services:
  a: { image: nginx, depends_on: [b] }
  b: { image: nginx, depends_on: [a] }
`);
    expect(errors.some((e) => e.includes('Circular depends_on'))).toBe(true);
  });

  test('reports a YAML parse error rather than throwing', () => {
    const result = validateCompose('services:\n  web:\n   - [unclosed\n');
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });
});
