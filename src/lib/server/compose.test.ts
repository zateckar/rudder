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

function plan(manifest: string, options: Partial<PlanContext> = {}) {
  return parseCompose(manifest, {
    appId: APP_ID,
    appName: 'shop',
    allocatePort: sequentialPorts(),
    ...options,
  });
}

function parse(manifest: string, options: Partial<PlanContext> = {}) {
  return plan(manifest, options).containers;
}

/** Every note as one string, for asserting on what was said. */
function notesOf(manifest: string, options: Partial<PlanContext> = {}) {
  return plan(manifest, options).notes.join('\n');
}

describe('environment', () => {
  test('keeps everything after the first = in a list-form value', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    environment:
      - JAVA_OPTS=-Dfoo=bar
      - SECRET_KEY=abc123==
      - DATABASE_URL=postgres://u:p@h/db?sslmode=require
`);
    expect(c.env).toContain('JAVA_OPTS=-Dfoo=bar');
    expect(c.env).toContain('SECRET_KEY=abc123==');
    expect(c.env).toContain('DATABASE_URL=postgres://u:p@h/db?sslmode=require');
  });

  test('a list entry with no value is an empty string, not a dropped key', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    environment:
      - EMPTY=
      - BARE
`);
    expect(c.env).toContain('EMPTY=');
    expect(c.env).toContain('BARE=');
  });

  test('the map form is unchanged', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    environment:
      APP_ENV: production
`);
    expect(c.env).toEqual(['APP_ENV=production']);
  });
});

describe('restart policy', () => {
  test('a service with no restart: gets the application\'s policy, not `no`', () => {
    // The compose default of `no` meant the Restart Policy field on the
    // application page was decoration: the container survived neither a crash
    // nor a worker reboot, whatever the user had picked.
    const [c] = parse(
      `
services:
  web:
    image: nginx
`,
      { restartPolicy: 'unless-stopped' },
    );
    expect(c.restartPolicy).toBe('unless-stopped');
  });

  test('falls back to always when the application has no policy either', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
`);
    expect(c.restartPolicy).toBe('always');
  });

  test('an explicit restart: wins over the application setting, including `no`', () => {
    const [none] = parse(
      `
services:
  web:
    image: nginx
    restart: "no"
`,
      { restartPolicy: 'always' },
    );
    expect(none.restartPolicy).toBe('no');

    const [onFailure] = parse(
      `
services:
  web:
    image: nginx
    restart: on-failure
`,
      { restartPolicy: 'always' },
    );
    expect(onFailure.restartPolicy).toBe('on-failure');
  });

  test('keeps the policy from a bounded on-failure:N, dropping only the bound', () => {
    // Podman takes the retry count as a separate field. This used to fall
    // through to `no` — the one policy the manifest definitively did not ask for.
    const [c] = parse(`
services:
  web:
    image: nginx
    restart: on-failure:5
`);
    expect(c.restartPolicy).toBe('on-failure');
  });
});

describe('resource limits', () => {
  test('honours the v3 deploy.resources.limits spelling', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
`);
    expect(c.memory).toBe(512 * 1024 * 1024);
    expect(c.cpuQuota).toBe(100000);
    expect(c.cpuPeriod).toBe(100000);
  });

  test('honours the v2 mem_limit spelling', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
    mem_limit: 256m
    cpus: 0.5
`);
    expect(c.memory).toBe(256 * 1024 * 1024);
    expect(c.cpuQuota).toBe(50000);
  });

  test('a service that sets no limits gets none', () => {
    const [c] = parse(`
services:
  web:
    image: nginx
`);
    expect(c.memory).toBeUndefined();
    expect(c.cpuQuota).toBeUndefined();
  });

  test('says compose secrets were not mounted', () => {
    const notes = notesOf(`
services:
  web:
    image: nginx
    secrets:
      - db_password
`);
    expect(notes).toContain('compose secret');
    expect(notes).toContain('/run/secrets');
  });
});

describe('deployment notes', () => {
  test('says how multi-service containers address each other', () => {
    // The Kubernetes path has always recorded this; compose returned [].
    const notes = notesOf(`
services:
  web:
    image: nginx
  api:
    image: traefik/whoami
`);
    expect(notes).toContain('2 containers');
    expect(notes).toContain('"web"');
    expect(notes).toContain('"api"');
    expect(notes).toMatch(/localhost/i);
  });

  test('a single-service file gets no networking note', () => {
    expect(notesOf(`
services:
  web:
    image: nginx
`)).not.toMatch(/bridge network/);
  });

  test('records that a requested host port was reallocated', () => {
    const notes = notesOf(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`);
    expect(notes).toContain('host port 8080');
    expect(notes).toMatch(/allocates host ports itself/);
  });

  test('says nothing about ports when the file did not pick one', () => {
    expect(notesOf(`
services:
  web:
    image: nginx
    ports:
      - "80"
`)).not.toMatch(/host port/);
  });

  test('records dropped traefik labels rather than dropping them silently', () => {
    const notes = notesOf(`
services:
  web:
    image: nginx
    labels:
      traefik.http.routers.mine.rule: Host(\`evil.example.com\`)
      app: shop
`);
    expect(notes).toContain('traefik.http.routers.mine.rule');
    expect(notes).toMatch(/dropped/);
  });

  test('warns that a depends_on condition is not waited on', () => {
    const notes = notesOf(`
services:
  web:
    image: nginx
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres
`);
    expect(notes).toContain('"web"');
    expect(notes).toMatch(/does not wait for a dependency to become healthy/);
  });

  test('a plain depends_on list is honoured, so it needs no warning', () => {
    expect(notesOf(`
services:
  web:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres
`)).not.toMatch(/become healthy/);
  });
});

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

  test('applies team labels', () => {
    const [c] = parse(`
services:
  web: { image: nginx }
`, {
      teamSlug: 'platform',
      team: { name: 'Platform', id: 'team-1' },
    });

    expect(c.labels.team).toBe('platform');
    expect(c.labels['rudder.team.id']).toBe('team-1');
    expect(c.labels['rudder.team.name']).toBe('Platform');
  });
});

describe('hostname assignment', () => {
  test('the first port-exposing service owns the application hostname', () => {
    const containers = parse(`
services:
  web: { image: nginx, ports: ["80"] }
  api: { image: nginx, ports: ["80"] }
`, { baseDomain: 'apps.example.com' });

    // The router name carries the application id and the hostname does not:
    // hostnames are already globally unique, router names are global on a
    // worker and application names are not. See `traefikRouterName`.
    expect(containers[0].routes[0]).toMatchObject({
      domain: 'shop.apps.example.com',
      routerName: 'shop-abcdef12',
      definesRouter: true,
    });
    expect(containers[1].routes[0]).toMatchObject({
      domain: 'shop-api.apps.example.com',
      routerName: 'shop-api-abcdef12',
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

    const domains = containers.map((c) => c.routes[0]!.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  test('an explicit app domain overrides the primary hostname only', () => {
    const containers = parse(`
services:
  web: { image: nginx, ports: ["80"] }
  api: { image: nginx, ports: ["80"] }
`, { baseDomain: 'apps.example.com', appDomain: 'custom.example.com' });

    expect(containers[0].routes[0]?.domain).toBe('custom.example.com');
    expect(containers[1].routes[0]?.domain).toBe('shop-api.apps.example.com');
  });

  test('the route names the allocated host port, not the declared one', () => {
    const [c] = parse(`
services:
  web: { image: nginx, ports: ["8080:80"] }
`, { baseDomain: 'apps.example.com' });
    expect(c.routes[0]?.hostPort).toBe(31000);
  });

  test('services without ports get no route', () => {
    const [c] = parse(`
services:
  worker: { image: nginx }
`, { baseDomain: 'apps.example.com' });
    expect(c.routes[0]).toBeUndefined();
  });

  test('nothing is routed without a base domain', () => {
    const [c] = parse(`
services:
  web: { image: nginx, ports: ["80"] }
`);
    expect(c.routes[0]).toBeUndefined();
  });
});

describe('public ports', () => {
  const VERSITY = `
services:
  versity:
    image: versitygw
    ports: ["7070:7070", "7071:7071", "8080:8080"]
`;

  test('undeclared routes the first published port, as it always has', () => {
    const [c] = parse(VERSITY, { baseDomain: 'apps.example.com' });
    expect(c.routes).toHaveLength(1);
    expect(c.routes[0].containerPort).toBe(7070);
    expect(c.routes[0].entryPoint).toBe('websecure');
  });

  test('the application declaration puts the second port on 1443', () => {
    const [c] = parse(VERSITY, {
      baseDomain: 'apps.example.com',
      exposedPorts: [7070, 8080],
    });
    expect(c.routes.map((r) => [r.containerPort, r.entryPoint])).toEqual([
      [7070, 'websecure'],
      [8080, 'websecure-1'],
    ]);
    // Same hostname, so no new DNS record and no new certificate.
    expect(new Set(c.routes.map((r) => r.domain)).size).toBe(1);
  });

  test('a service label overrides the application, per service', () => {
    // The one case the application-level list cannot express: two services of
    // one file wanting different ports public.
    const containers = parse(
      `
services:
  gateway:
    image: versitygw
    ports: ["7070:7070", "8080:8080"]
    labels:
      rudder.expose: "7070"
  webui:
    image: versitygw
    ports: ["7070:7070", "8080:8080"]
    labels:
      rudder.expose: "8080"
`,
      { baseDomain: 'apps.example.com', exposedPorts: [7070, 8080] },
    );
    expect(containers[0].routes.map((r) => r.containerPort)).toEqual([7070]);
    expect(containers[1].routes.map((r) => r.containerPort)).toEqual([8080]);
  });

  test('the label is consumed, not passed to Podman as a user label', () => {
    const [c] = parse(
      `
services:
  web:
    image: nginx
    ports: ["80"]
    labels:
      rudder.expose: "80"
      owner: platform
`,
      { baseDomain: 'apps.example.com' },
    );
    expect(c.labels['rudder.expose']).toBeUndefined();
    expect(c.labels.owner).toBe('platform');
  });

  test('an unusable label falls back to the application rather than to nothing', () => {
    const notes = notesOf(
      `
services:
  web:
    image: nginx
    ports: ["80:80", "443:443"]
    labels:
      rudder.expose: "eighty"
`,
      { baseDomain: 'apps.example.com', exposedPorts: [443] },
    );
    expect(notes).toContain('rudder.expose');
    const [c] = parse(
      `
services:
  web:
    image: nginx
    ports: ["80:80", "443:443"]
    labels:
      rudder.expose: "eighty"
`,
      { baseDomain: 'apps.example.com', exposedPorts: [443] },
    );
    expect(c.routes.map((r) => r.containerPort)).toEqual([443]);
  });

  test('a declared port the service does not publish is reported', () => {
    const notes = notesOf(VERSITY, {
      baseDomain: 'apps.example.com',
      exposedPorts: [7070, 9999],
    });
    expect(notes).toContain('9999');
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
    // `web` is declared first and is the public face of the application, but it
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

    const hostOf = (key: string) => containers.find((c) => c.key === key)!.routes[0]!.domain;
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

  test('a YAML error says where it is and says it once', () => {
    const result = validateCompose('services:\n  web:\n   - [unclosed\n');
    expect(result.errors[0]).toMatch(/line 3/);
    // "YAML parse error: YAML Parse error: Unexpected token" said it twice.
    expect(result.errors[0].match(/parse error/gi)).toHaveLength(1);
  });
});
