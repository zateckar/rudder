import { describe, expect, test } from 'bun:test';
import {
  k8sPodTemplate,
  parseK8sManifest as parseManifest,
  tmpfsSize,
  validateK8sManifest,
} from './kubernetes';
import type { PlanContext } from './deploy/plan';
import { PORT_RANGE_END, PORT_RANGE_START, unreservedPort } from './ports';

/** Deterministic stand-in for the deploy path's collision-checked allocator. */
function sequentialAllocator(start = 31000) {
  let next = start;
  return () => next++;
}

/** Slices to `abcdef12`, which is what appears in generated names. */
const APP_ID = 'abcdef1234567890';

function parseK8sManifest(
  manifest: string,
  appName: string,
  options: Partial<PlanContext> = {},
) {
  return parseManifest(manifest, {
    appId: APP_ID,
    appName,
    allocatePort: sequentialAllocator(),
    ...options,
  }).containers;
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
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop');
    expect(c.key).toBe('web');
    expect(c.name).toBe('shop-abcdef12-web');
    expect(c.image).toBe('nginx:1.25');
    // Keyed by the port inside the container; the host port is allocated.
    expect(c.ports).toEqual({ '8080/tcp': [{ hostPort: '31000' }] });
  });

  test('reads environment, defaulting a valueless entry to empty', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop');
    expect(c.env).toEqual(['LOG_LEVEL=debug', 'EMPTY=']);
  });

  test('applies app and team labels', () => {
    const [c] = parseK8sManifest(DEPLOYMENT, 'shop', { teamSlug: 'platform' });
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
    const [c] = parseK8sManifest(TWO_CONTAINERS, 'pair');
    expect(Object.keys(c.ports)).toEqual(['80/tcp']);
    expect(c.ports['80/tcp'][0].hostPort).toBe('31000');
  });

  test('draws a distinct host port for every published port', () => {
    const containers = parseK8sManifest(TWO_CONTAINERS, 'pair');
    const hostPorts = containers.flatMap((c) =>
      Object.values(c.ports).map((bindings) => bindings[0].hostPort),
    );
    expect(hostPorts).toHaveLength(3);
    expect(new Set(hostPorts).size).toBe(3);
  });

  test('two containers listening on the same port do not collide', () => {
    const [web, admin] = parseK8sManifest(TWO_CONTAINERS, 'pair');
    expect(web.ports['80/tcp'][0].hostPort).not.toBe(admin.ports['80/tcp'][0].hostPort);
  });

  test('draws from the safe range, below the kernel ephemeral floor', () => {
    // The deploy path's allocator narrows further by excluding ports already
    // held on the worker, but the range itself is what keeps a container from
    // being handed a port the kernel is about to use for an outbound socket.
    const [c] = parseK8sManifest(TWO_CONTAINERS, 'pair', { allocatePort: unreservedPort });
    const port = Number(c.ports['80/tcp'][0].hostPort);
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThan(PORT_RANGE_END);
  });

  test('a container with no ports declares no bindings', () => {
    const noPorts = TWO_CONTAINERS.replace(/      ports:\n(        - containerPort: \d+\n)+/g, '');
    const containers = parseK8sManifest(noPorts, 'pair', {
      allocatePort: () => {
        throw new Error('should not allocate for a container that publishes nothing');
      },
    });
    for (const c of containers) expect(Object.keys(c.ports)).toHaveLength(0);
  });
});

describe('parseK8sManifest — public ports', () => {
  const MULTI = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: versity
spec:
  template:
    spec:
      containers:
        - name: gw
          image: versitygw
          ports:
            - containerPort: 7070
            - containerPort: 7071
            - containerPort: 8080
`;

  test('undeclared routes the first published port, as it always has', () => {
    const [c] = parseK8sManifest(MULTI, 'versity', { baseDomain: 'apps.example.com' });
    expect(c.routes).toHaveLength(1);
    expect(c.routes[0].containerPort).toBe(7070);
  });

  test('the declaration assigns entryPoints in its own order', () => {
    const [c] = parseK8sManifest(MULTI, 'versity', {
      baseDomain: 'apps.example.com',
      exposedPorts: [8080, 7070],
    });
    expect(c.routes.map((r) => [r.containerPort, r.entryPoint])).toEqual([
      [8080, 'websecure'],
      [7070, 'websecure-1'],
    ]);
  });

  test('a declared port the pod does not publish is reported', () => {
    const plan = parseManifest(MULTI, {
      appId: APP_ID,
      appName: 'versity',
      baseDomain: 'apps.example.com',
      allocatePort: sequentialAllocator(),
      exposedPorts: [7070, 9999],
    });
    expect(plan.notes.join('\n')).toContain('9999');
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

  test('maps command onto the entrypoint and args onto the command', () => {
    // Kubernetes and OCI make the same split under swapped names. Putting k8s
    // `command` into Podman's Cmd left the image's own ENTRYPOINT in front of
    // it, and `args` was dropped entirely.
    const [c] = parseK8sManifest(POD, 'tool');
    expect(c.entrypoint).toEqual(['sh', '-c']);
    expect(c.command).toEqual(['sleep 1']);
    expect(c.workingDir).toBe('/work');
  });

  test('translates the restart policy into the spelling Podman accepts', () => {
    // Podman rejects `OnFailure` outright, so a manifest that declared any
    // restart policy failed to create its containers.
    expect(parseK8sManifest(POD, 'tool')[0].restartPolicy).toBe('on-failure');
    expect(parseK8sManifest(POD.replace('OnFailure', 'Always'), 'tool')[0].restartPolicy).toBe('always');
    expect(parseK8sManifest(POD.replace('OnFailure', 'Never'), 'tool')[0].restartPolicy).toBe('no');
  });

  test('falls back to the application policy when the Pod declares none', () => {
    const noPolicy = POD.replace('  restartPolicy: OnFailure\n', '');
    expect(parseK8sManifest(noPolicy, 'tool')[0].restartPolicy).toBe('always');
    expect(parseK8sManifest(noPolicy, 'tool', { restartPolicy: 'unless-stopped' })[0].restartPolicy)
      .toBe('unless-stopped');
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
    expect(c.cpuQuota).toBeGreaterThan(0);
    expect(c.cpuPeriod).toBe(100000);
  });
});

describe('parseK8sManifest — storage', () => {
  /** A Pod with one container mounting `data` at /data, plus whatever precedes it. */
  const podWith = (volume: string, extra = '') => `${extra}
apiVersion: v1
kind: Pod
metadata:
  name: store
spec:
  volumes:
${volume}
  containers:
    - name: app
      image: busybox
      volumeMounts:
        - name: data
          mountPath: /data
`;

  test('backs an emptyDir with memory', () => {
    // Ephemeral is the intent. It used to be mapped to an empty host path and
    // filtered out before it reached Podman, so the container got nothing.
    const [c] = parseK8sManifest(podWith('    - name: data\n      emptyDir: {}'), 'store');
    expect(c.mounts).toEqual([{ kind: 'tmpfs', target: '/data', options: 'rw,nosuid,nodev' }]);
  });

  test('translates an emptyDir size limit into a tmpfs size', () => {
    // Kubernetes writes 64Mi; tmpfs reads a bare `m` as mebibytes and rejects
    // `Mi` with "Invalid argument", naming neither the option nor the mount.
    const [c] = parseK8sManifest(
      podWith('    - name: data\n      emptyDir:\n        sizeLimit: 64Mi'),
      'store',
    );
    expect(c.mounts[0]).toMatchObject({ options: 'rw,nosuid,nodev,size=64m' });
  });

  test('refuses a size limit it cannot translate', () => {
    expect(() =>
      parseK8sManifest(podWith('    - name: data\n      emptyDir:\n        sizeLimit: lots'), 'store'),
    ).toThrow(/not a quantity Rudder can turn into a tmpfs size/);
  });

  test('refuses an emptyDir two containers share', () => {
    // Sharing one needs a shared namespace, and there are no pods here. Two
    // separate scratch directories is not what the manifest asked for.
    const shared = `
apiVersion: v1
kind: Pod
metadata:
  name: store
spec:
  volumes:
    - name: data
      emptyDir: {}
  containers:
    - name: writer
      image: busybox
      volumeMounts: [{ name: data, mountPath: /data }]
    - name: reader
      image: busybox
      volumeMounts: [{ name: data, mountPath: /data }]
`;
    expect(() => parseK8sManifest(shared, 'store')).toThrow(/"writer" and "reader"/);
  });

  test('delivers a ConfigMap declared in the same manifest as files', () => {
    const [c] = parseK8sManifest(
      podWith('    - name: data\n      configMap:\n        name: settings', `apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
data:
  app.conf: "listen 8080"
  motd: hello
---`),
      'store',
    );
    expect(c.mounts).toEqual([{ kind: 'tmpfs', target: '/data', options: 'rw,nosuid,nodev' }]);
    expect(c.files).toEqual([
      { dir: '/data', name: 'app.conf', content: 'listen 8080', mode: 0o644 },
      { dir: '/data', name: 'motd', content: 'hello', mode: 0o644 },
    ]);
  });

  test('decodes a Secret and delivers it read-only to root', () => {
    const [c] = parseK8sManifest(
      podWith('    - name: data\n      secret:\n        secretName: creds', `apiVersion: v1
kind: Secret
metadata:
  name: creds
data:
  token: ${Buffer.from('s3cr3t').toString('base64')}
---`),
      'store',
    );
    expect(c.files).toEqual([{ dir: '/data', name: 'token', content: 's3cr3t', mode: 0o400 }]);
  });

  test('reads a ConfigMap declared after the Pod that mounts it', () => {
    // Document order would otherwise be a dependency nobody could debug from
    // the error message.
    const manifest = `${podWith('    - name: data\n      configMap:\n        name: settings')}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
data:
  a: "1"
`;
    expect(parseK8sManifest(manifest, 'store')[0].files).toHaveLength(1);
  });

  test('selects and renames keys with items', () => {
    const [c] = parseK8sManifest(
      podWith(
        '    - name: data\n      configMap:\n        name: settings\n        items:\n          - key: motd\n            path: banner.txt',
        `apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
data:
  app.conf: "listen 8080"
  motd: hello
---`,
      ),
      'store',
    );
    expect(c.files).toEqual([{ dir: '/data', name: 'banner.txt', content: 'hello', mode: 0o644 }]);
  });

  test('refuses a reference to a ConfigMap that is not in the manifest', () => {
    expect(() =>
      parseK8sManifest(podWith('    - name: data\n      configMap:\n        name: absent'), 'store'),
    ).toThrow(/ConfigMap "absent", which is not declared/);
  });

  test('mounts nothing when the missing reference is optional', () => {
    // Kubernetes' own escape hatch, honoured rather than second-guessed.
    const [c] = parseK8sManifest(
      podWith('    - name: data\n      configMap:\n        name: absent\n        optional: true'),
      'store',
    );
    expect(c.files).toBeUndefined();
    expect(c.mounts).toHaveLength(1);
  });

  test('refuses a volume kind that needs a cluster behind it', () => {
    expect(() =>
      parseK8sManifest(
        podWith('    - name: data\n      persistentVolumeClaim:\n        claimName: pvc'),
        'store',
      ),
    ).toThrow(/persistentVolumeClaim volume/);
  });

  test('refuses a mount of a volume the Pod never declared', () => {
    const orphan = `
apiVersion: v1
kind: Pod
metadata:
  name: store
spec:
  containers:
    - name: app
      image: busybox
      volumeMounts: [{ name: data, mountPath: /data }]
`;
    expect(() => parseK8sManifest(orphan, 'store')).toThrow(/no volume of that name is declared/);
  });

  test('refuses subPath rather than mounting the whole volume instead', () => {
    const sub = podWith('    - name: data\n      emptyDir: {}').replace(
      '          mountPath: /data',
      '          mountPath: /data\n          subPath: inner',
    );
    expect(() => parseK8sManifest(sub, 'store')).toThrow(/subPath/);
  });
});

describe('tmpfsSize', () => {
  test('maps binary quantities onto tmpfs suffixes', () => {
    expect(tmpfsSize('512Ki', 'x')).toBe('512k');
    expect(tmpfsSize('64Mi', 'x')).toBe('64m');
    expect(tmpfsSize('2Gi', 'x')).toBe('2g');
  });

  test('expands decimal quantities to bytes, which tmpfs reads unambiguously', () => {
    expect(tmpfsSize('100M', 'x')).toBe('100000000');
    expect(tmpfsSize('1G', 'x')).toBe('1000000000');
  });

  test('passes a bare byte count through', () => {
    expect(tmpfsSize('1048576', 'x')).toBe('1048576');
  });

  test('is undefined when no limit is set', () => {
    expect(tmpfsSize(undefined, 'x')).toBeUndefined();
    expect(tmpfsSize('  ', 'x')).toBeUndefined();
  });
});

describe('parseK8sManifest — environment from other objects', () => {
  const OBJECTS = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
data:
  LOG_LEVEL: debug
  REGION: eu
---
apiVersion: v1
kind: Secret
metadata:
  name: creds
stringData:
  TOKEN: s3cr3t
---`;

  const podWithEnv = (env: string) => `${OBJECTS}
apiVersion: v1
kind: Pod
metadata:
  name: envtest
spec:
  containers:
    - name: app
      image: busybox
${env}
`;

  test('pulls every key in with envFrom', () => {
    const [c] = parseK8sManifest(
      podWithEnv('      envFrom:\n        - configMapRef:\n            name: settings'),
      'envtest',
    );
    expect(c.env).toEqual(['LOG_LEVEL=debug', 'REGION=eu']);
  });

  test('applies an envFrom prefix', () => {
    const [c] = parseK8sManifest(
      podWithEnv('      envFrom:\n        - prefix: APP_\n          configMapRef:\n            name: settings'),
      'envtest',
    );
    expect(c.env).toEqual(['APP_LOG_LEVEL=debug', 'APP_REGION=eu']);
  });

  test('resolves a single key by reference', () => {
    const [c] = parseK8sManifest(
      podWithEnv(
        '      env:\n        - name: TOKEN\n          valueFrom:\n            secretKeyRef:\n              name: creds\n              key: TOKEN',
      ),
      'envtest',
    );
    expect(c.env).toEqual(['TOKEN=s3cr3t']);
  });

  test('an explicit env entry wins over envFrom', () => {
    const [c] = parseK8sManifest(
      podWithEnv(
        '      envFrom:\n        - configMapRef:\n            name: settings\n      env:\n        - name: LOG_LEVEL\n          value: warn',
      ),
      'envtest',
    );
    expect(c.env).toContain('LOG_LEVEL=warn');
    expect(c.env).not.toContain('LOG_LEVEL=debug');
  });

  test('refuses a key that is not in the object', () => {
    expect(() =>
      parseK8sManifest(
        podWithEnv(
          '      env:\n        - name: X\n          valueFrom:\n            configMapKeyRef:\n              name: settings\n              key: MISSING',
        ),
        'envtest',
      ),
    ).toThrow(/has no such key/);
  });

  test('refuses fieldRef, which describes a Pod that does not exist here', () => {
    expect(() =>
      parseK8sManifest(
        podWithEnv(
          '      env:\n        - name: POD_NAME\n          valueFrom:\n            fieldRef:\n              fieldPath: metadata.name',
        ),
        'envtest',
      ),
    ).toThrow(/fieldRef \(metadata\.name\)/);
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
    expect(c.key).toBe('web');
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
