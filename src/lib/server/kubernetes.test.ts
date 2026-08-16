import { describe, expect, test } from 'bun:test';
import { k8sPodTemplate, parseK8sManifest, validateK8sManifest } from './kubernetes';
import { PORT_RANGE_END, PORT_RANGE_START } from './ports';

/** Deterministic stand-in for the deploy path's collision-checked allocator. */
function sequentialAllocator(start = 31000) {
  let next = start;
  return () => next++;
}

const DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
  labels:
    tier: frontend
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.25
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: debug
            - name: EMPTY
`;

describe('parseK8sManifest — Deployment', () => {
  test('extracts the container', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop', undefined, {
      allocatePort: sequentialAllocator(),
    });
    expect(c.name).toBe('web');
    expect(c.image).toBe('nginx:1.25');
    // Keyed by the port inside the container; the host port is allocated.
    expect(c.ports).toEqual({ '8080/tcp': [{ hostPort: '31000' }] });
  });

  test('reads environment, defaulting a valueless entry to empty', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop');
    expect(c.env).toEqual({ LOG_LEVEL: 'debug', EMPTY: '' });
  });

  test('applies app and team labels', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop', 'platform');
    expect(c.labels.app).toBe('shop');
    expect(c.labels.team).toBe('platform');
    expect(c.labels.tier).toBe('frontend');
  });

  test('derives the k8s version label from the image tag', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop');
    expect(c.labels['app.kubernetes.io/version']).toBe('1.25');
  });

  test('defaults the version label when the image is untagged', () => {
    const [c] = parseK8sManifest(DEPLOYMENT.replace('nginx:1.25', 'nginx'), 'shop');
    expect(c.labels['app.kubernetes.io/version']).toBe('latest');
  });

  test('strips traefik.* labels from user metadata', () => {
    const hijack = DEPLOYMENT.replace(
      '    tier: frontend',
      '    tier: frontend\n    traefik.http.routers.evil.rule: whatever'
    );
    const [c] = parseK8sManifest(hijack, 'shop');
    expect(Object.keys(c.labels).some((k) => k.toLowerCase().startsWith('traefik.'))).toBe(false);
  });
});

describe('parseK8sManifest — host port allocation', () => {
  const TWO_CONTAINERS = `
apiVersion: v1
kind: Pod
metadata:
  name: pair
spec:
  containers:
    - name: web
      image: nginx
      ports:
        - containerPort: 80
    - name: admin
      image: nginx
      ports:
        - containerPort: 80
        - containerPort: 9000
`;

  test('never publishes on the port the manifest names', () => {
    // The whole point: a Pod spec's containerPort is the port inside the
    // container. Publishing it verbatim meant two applications that both
    // listened on 80 could not share a worker.
    const [c] = parseK8sManifest(TWO_CONTAINERS, 'pair', undefined, {
      allocatePort: sequentialAllocator(),
    });
    expect(Object.keys(c.ports)).toEqual(['80/tcp']);
    expect(c.ports['80/tcp'][0].hostPort).toBe('31000');
  });

  test('draws a distinct host port for every published port', () => {
    const containers = parseK8sManifest(TWO_CONTAINERS, 'pair', undefined, {
      allocatePort: sequentialAllocator(),
    });
    const hostPorts = containers.flatMap((c) =>
      Object.values(c.ports).map((bindings) => bindings[0].hostPort),
    );
    expect(hostPorts).toHaveLength(3);
    expect(new Set(hostPorts).size).toBe(3);
  });

  test('two containers listening on the same port do not collide', () => {
    const [web, admin] = parseK8sManifest(TWO_CONTAINERS, 'pair', undefined, {
      allocatePort: sequentialAllocator(),
    });
    expect(web.ports['80/tcp'][0].hostPort).not.toBe(admin.ports['80/tcp'][0].hostPort);
  });

  test('falls back to the safe range when no allocator is supplied', () => {
    // Only reachable from callers inspecting a manifest rather than deploying
    // it, but it must still stay below the kernel's ephemeral port floor.
    const [c] = parseK8sManifest(TWO_CONTAINERS, 'pair');
    const port = Number(c.ports['80/tcp'][0].hostPort);
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThan(PORT_RANGE_END);
  });

  test('a container with no ports declares no bindings', () => {
    const noPorts = TWO_CONTAINERS.replace(/      ports:\n(        - containerPort: \d+\n)+/g, '');
    const containers = parseK8sManifest(noPorts, 'pair', undefined, {
      allocatePort: () => {
        throw new Error('should not allocate for a container that publishes nothing');
      },
    });
    for (const c of containers) expect(Object.keys(c.ports)).toHaveLength(0);
  });
});

describe('parseK8sManifest — network aliases', () => {
  const PAIR = `
apiVersion: v1
kind: Pod
metadata:
  name: pair
spec:
  containers:
    - name: web
      image: nginx
    - name: db
      image: postgres
`;

  test('gives every container a name its siblings can use', () => {
    // A Pod's containers would share localhost in Kubernetes. Here they get
    // separate addresses on a bridge, so the names are the only way across.
    const [web, db] = parseK8sManifest(PAIR, 'pair');
    expect(web.aliases).toEqual(['web', 'pair-web']);
    expect(db.aliases).toEqual(['db', 'pair-db']);
  });

  test('records the bare alias as a label', () => {
    const [web] = parseK8sManifest(PAIR, 'pair');
    expect(web.labels['rudder.alias']).toBe('web');
  });

  test('keeps the alias label on a Deployment, whose labels are rebuilt', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop');
    expect(c.labels['rudder.alias']).toBe(c.aliases[0]);
  });

  test('refuses two containers claiming one alias', () => {
    // Two Deployments in one manifest may each name a container `web`;
    // Kubernetes allows it because they are separate Pods, and this is not.
    const clash = `${PAIR}\n---\n${PAIR.replace('name: db', 'name: web')}`;
    expect(() => parseK8sManifest(clash, 'pair')).toThrow(/both named "web"/);
  });
});

describe('k8sPodTemplate', () => {
  test('reads image and declared ports from a Deployment', () => {
    // What kubectl gets back for a Deployment it applied. These are the ports
    // *inside* the container, so they must come from the manifest and never
    // from the allocated host port on the container row.
    expect(k8sPodTemplate(DEPLOYMENT)).toEqual({
      image: 'nginx:1.25',
      ports: [{ containerPort: 8080, protocol: 'TCP' }],
    });
  });

  test('reads a Pod body', () => {
    const pod = `
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      image: busybox:1.36
      ports:
        - containerPort: 9000
          protocol: udp
`;
    expect(k8sPodTemplate(pod)).toEqual({
      image: 'busybox:1.36',
      ports: [{ containerPort: 9000, protocol: 'UDP' }],
    });
  });

  test('reads the JSON body kubectl stores', () => {
    const json = JSON.stringify({
      kind: 'Deployment',
      spec: { template: { spec: { containers: [{ name: 'web', image: 'nginx' }] } } },
    });
    expect(k8sPodTemplate(json)).toEqual({ image: 'nginx', ports: [] });
  });

  test('is null for anything that is not a Pod or Deployment', () => {
    expect(k8sPodTemplate('{"image":"nginx:1.25"}')).toBeNull();
    expect(k8sPodTemplate('kind: Service\nspec: {}')).toBeNull();
    expect(k8sPodTemplate('{not json')).toBeNull();
    expect(k8sPodTemplate(null)).toBeNull();
    expect(k8sPodTemplate('   ')).toBeNull();
  });

  test('allocates nothing', () => {
    // It exists so the compatibility API can describe a manifest without
    // pretending to deploy it.
    const before = k8sPodTemplate(DEPLOYMENT);
    expect(k8sPodTemplate(DEPLOYMENT)).toEqual(before!);
  });
});

describe('parseK8sManifest — Pod', () => {
  const POD = `
apiVersion: v1
kind: Pod
metadata:
  name: standalone
spec:
  restartPolicy: OnFailure
  volumes:
    - name: data
      hostPath:
        path: /srv/data
  containers:
    - name: app
      image: busybox
      command: ["sh", "-c"]
      args: ["sleep 1"]
      workingDir: /work
      volumeMounts:
        - name: data
          mountPath: /data
          readOnly: true
      resources:
        limits:
          memory: 512M
          cpu: "2"
`;

  test('extracts command, args and working directory', () => {
    const [c] = parseK8sManifest(POD, 'tool');
    expect(c.command).toEqual(['sh', '-c']);
    expect(c.args).toEqual(['sleep 1']);
    expect(c.workingDir).toBe('/work');
    expect(c.restartPolicy).toBe('OnFailure');
  });

  test('resolves a volumeMount against the pod volume', () => {
    const [c] = parseK8sManifest(POD, 'tool');
    expect(c.mounts).toEqual([
      { kind: 'bind', source: '/srv/data', target: '/data', mode: 'ro' },
    ]);
  });

  test('parses resource limits', () => {
    const [c] = parseK8sManifest(POD, 'tool');
    expect(c.memory).toBe(512 * 1024 * 1024);
    expect(c.cpuShares).toBeGreaterThan(0);
  });
});

describe('parseK8sManifest — input handling', () => {
  test('accepts JSON, as stored by the kubectl-compatible API', () => {
    const json = JSON.stringify({
      kind: 'Deployment',
      metadata: { name: 'shop' },
      spec: { template: { spec: { containers: [{ name: 'web', image: 'nginx' }] } } },
    });
    const [c] = parseK8sManifest(json, 'shop');
    expect(c.name).toBe('web');
  });

  test('handles multi-document YAML, ignoring non-workload kinds', () => {
    const multi = `${DEPLOYMENT}
---
apiVersion: v1
kind: Service
metadata:
  name: shop
spec:
  ports:
    - port: 80
      targetPort: 8080
`;
    expect(parseK8sManifest(multi, 'shop')).toHaveLength(1);
  });

  test('throws when the manifest contains no workload', () => {
    const serviceOnly = `
apiVersion: v1
kind: Service
metadata:
  name: shop
`;
    expect(() => parseK8sManifest(serviceOnly, 'shop')).toThrow(/No Pod or Deployment/);
  });

  test('defaults a container without an image to <name>:latest', () => {
    const noImage = DEPLOYMENT.replace('          image: nginx:1.25\n', '');
    const [c] = parseK8sManifest(noImage, 'shop');
    expect(c.image).toBe('web:latest');
  });
});

describe('validateK8sManifest', () => {
  test('accepts a valid deployment', () => {
    expect(validateK8sManifest(DEPLOYMENT).valid).toBe(true);
  });

  test('rejects unparseable input without throwing', () => {
    const result = validateK8sManifest(': : :\n\t- broken');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
