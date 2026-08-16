import { describe, expect, test } from 'bun:test';
import { parseK8sManifest, validateK8sManifest } from './kubernetes';

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
    expect(c.name).toBe('web');
    expect(c.image).toBe('nginx:1.25');
    expect(c.ports).toEqual({ '8080/tcp': [{ hostPort: '8080' }] });
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
    expect(c.volumes['/srv/data']).toEqual({ bind: '/data', options: 'ro' });
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
