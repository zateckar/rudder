import { describe, expect, test } from 'bun:test';
import { containerPortOf, containerToPod, imageReferenceOrBlank, podNameOf } from './mapper';

describe('imageReferenceOrBlank', () => {
  test('accepts a bare image reference', () => {
    // The oldest single-container applications stored exactly this as their
    // whole manifest.
    expect(imageReferenceOrBlank('nginx')).toBe('nginx');
    expect(imageReferenceOrBlank('docker.io/library/nginx:1.27')).toBe('docker.io/library/nginx:1.27');
    expect(imageReferenceOrBlank('  nginx:alpine  ')).toBe('nginx:alpine');
  });

  test('refuses to present a compose file as an image name', () => {
    // This is the bug it exists for: the manifest was echoed verbatim into
    // `kubectl get deploy -o yaml`, so a compose file's environment block —
    // API keys, passwords — was readable by anyone with a key for that team.
    const compose = [
      'services:',
      '  app:',
      '    image: ghcr.io/example/app:latest',
      '    environment:',
      '      - API_KEY=super-secret',
    ].join('\n');
    expect(imageReferenceOrBlank(compose)).toBe('');
  });

  test('is blank for anything else that is not one token', () => {
    expect(imageReferenceOrBlank('kind: Deployment')).toBe('');
    expect(imageReferenceOrBlank('nginx latest')).toBe('');
    expect(imageReferenceOrBlank('')).toBe('');
    expect(imageReferenceOrBlank(null)).toBe('');
    expect(imageReferenceOrBlank('a'.repeat(300))).toBe('');
  });
});

describe('containerPortOf', () => {
  test('reports the port inside the container, not the host port', () => {
    // The distinction only started to matter when host ports became allocated:
    // before that a k8s manifest's containerPort was published verbatim and the
    // two numbers were the same.
    expect(containerPortOf('{"80/tcp":[{"hostPort":"31204"}]}', 31204)).toBe(80);
  });

  test('picks the binding that carries the routed host port', () => {
    const ports = '{"9000/tcp":[{"hostPort":"31000"}],"80/tcp":[{"hostPort":"31001"}]}';
    expect(containerPortOf(ports, 31001)).toBe(80);
  });

  test('accepts Podman inspect capitalisation', () => {
    expect(containerPortOf('{"8080/tcp":[{"HostPort":"31500"}]}', 31500)).toBe(8080);
  });

  test('falls back to the host port for rows with no recorded bindings', () => {
    // Everything deployed before bindings were stored. Reporting the host port
    // is what those rows did anyway, so nothing changes for them.
    expect(containerPortOf(null, 31204)).toBe(31204);
    expect(containerPortOf(undefined, 31204)).toBe(31204);
    expect(containerPortOf('', 31204)).toBe(31204);
  });

  test('falls back when the record is unusable', () => {
    expect(containerPortOf('{not json', 31204)).toBe(31204);
    expect(containerPortOf('{}', 31204)).toBe(31204);
    expect(containerPortOf('{"tcp":[{"hostPort":"31204"}]}', 31204)).toBe(31204);
  });

  test('uses the first binding when none matches the routed port', () => {
    expect(containerPortOf('{"80/tcp":[{"hostPort":"31001"}]}', 39999)).toBe(80);
  });

  test('is null when there is nothing to report', () => {
    expect(containerPortOf(null, null)).toBeNull();
  });
});

describe('containerToPod', () => {
  const base = {
    id: 'c1',
    name: 'shop-1a2b3c4d-web-g3',
    containerId: 'abc123',
    image: 'nginx:1.25',
    workerId: 'w1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:05:00Z'),
  };

  test('advertises the container port kubectl expects', () => {
    const pod = containerToPod(
      { ...base, status: 'running', ports: '{"80/tcp":[{"hostPort":"31204"}]}', exposedPort: 31204 },
      'shop',
      'platform',
    );
    expect(pod.spec.containers[0].ports).toEqual([{ containerPort: 80, protocol: 'TCP' }]);
  });

  test('omits ports entirely when the container publishes none', () => {
    const pod = containerToPod({ ...base, status: 'running', ports: null, exposedPort: null }, 'shop', 'platform');
    expect(pod.spec.containers[0].ports).toBeUndefined();
  });

  test('reports a retained generation as finished, not unknown', () => {
    // A generation kept for a fast rollback is stopped. Calling that Unknown
    // would make `kubectl get pods` look broken for the whole retention window.
    const pod = containerToPod({ ...base, status: 'stopped', ports: null, exposedPort: null }, 'shop', 'platform');
    expect(pod.status.phase).toBe('Succeeded');
  });

  test('strips the leading slash a discovered container carries', () => {
    const pod = containerToPod({ ...base, name: '/whoami', status: 'running', ports: null, exposedPort: null }, 'shop', 'platform');
    expect(pod.metadata.name).toBe('whoami');
    expect(podNameOf('/whoami')).toBe('whoami');
  });

  test('reports exactly one container, because that is what it is', () => {
    // A Pod object listing several containers would promise a shared network
    // namespace and therefore localhost between them. Rudder runs each
    // container on its own address on a bridge; the mapping stays 1:1 so the
    // status object cannot imply otherwise.
    const pod = containerToPod({ ...base, status: 'running', ports: null, exposedPort: null }, 'shop', 'platform');
    expect(pod.spec.containers).toHaveLength(1);
    expect(pod.status.containerStatuses).toHaveLength(1);
    expect(pod.spec.containers[0].name).toBe(pod.metadata.name);
  });
});
