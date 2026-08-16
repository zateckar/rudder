import { describe, expect, test } from 'bun:test';
import {
  containerKeyOf,
  containerPortOf,
  containerToPod,
  imageReferenceOrBlank,
  podGroupToPod,
  podGroupsFor,
  podNameOf,
} from './mapper';

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
});

describe('containerKeyOf', () => {
  test('reads the alias the deploy path stamped', () => {
    expect(containerKeyOf({ name: 'shop-1a2b3c4d-web-g3', labels: '{"rudder.alias":"web"}' })).toBe('web');
  });

  test('falls back to the container name for rows without one', () => {
    // Rows written before the label existed, and containers discovered on a
    // worker rather than deployed by Rudder.
    expect(containerKeyOf({ name: '/whoami', labels: null })).toBe('whoami');
    expect(containerKeyOf({ name: 'legacy', labels: '{not json' })).toBe('legacy');
  });
});

describe('podGroupsFor', () => {
  const row = (id: string, key: string, generation = 1) => ({
    id,
    name: `shop-1a2b3c4d-${key}-g${generation}`,
    containerId: `cid-${id}`,
    image: 'nginx:1.25',
    status: 'running',
    ports: null,
    exposedPort: null,
    labels: JSON.stringify({ 'rudder.alias': key }),
    generation,
    workerId: 'w1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:05:00Z'),
  });

  test('reports a Kubernetes application as one Pod holding its containers', () => {
    // `kubectl apply` was given one Pod. Reporting a two-container manifest as
    // two Pods described something the user never wrote.
    const groups = podGroupsFor({ name: 'shop', type: 'k8s' }, [row('a', 'web'), row('b', 'side')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('shop');
    const pod = podGroupToPod(groups[0], 'shop', 'platform');
    expect(pod.spec.containers.map((c) => c.name)).toEqual(['web', 'side']);
    expect(pod.status.containerStatuses.map((c) => c.name)).toEqual(['web', 'side']);
  });

  test('keeps a retained generation as its own Pod', () => {
    // Separate running processes. Merging them would list stopped containers
    // as part of the Pod serving traffic.
    const groups = podGroupsFor({ name: 'shop', type: 'k8s' }, [
      row('a', 'web', 2),
      row('b', 'web', 3),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['shop-g2', 'shop-g3']);
  });

  test('leaves compose services as one Pod each', () => {
    // Separate workloads that happen to share a file.
    const groups = podGroupsFor({ name: 'shop', type: 'compose' }, [row('a', 'web'), row('b', 'db')]);
    expect(groups.map((g) => g.name)).toEqual(['shop-1a2b3c4d-web-g1', 'shop-1a2b3c4d-db-g1']);
  });

  test('leaves replicas as one Pod each', () => {
    // A replica genuinely is a separate Pod.
    const groups = podGroupsFor({ name: 'shop', type: 'single' }, [row('a', 'shop'), row('b', 'shop')]);
    expect(groups).toHaveLength(2);
  });

  test('a Pod is not Ready until every container is', () => {
    const groups = podGroupsFor({ name: 'shop', type: 'k8s' }, [
      row('a', 'web'),
      { ...row('b', 'side'), status: 'created' },
    ]);
    const pod = podGroupToPod(groups[0], 'shop', 'platform');
    expect(pod.status.phase).toBe('Pending');
    expect(pod.status.conditions.find((c) => c.type === 'Ready')?.status).toBe('False');
  });
});
