import { describe, expect, test } from 'bun:test';
import {
  composeMounts,
  composeServiceNames,
  k8sVolumeSnippet,
  useVolumeInCompose,
} from './manifest-volumes';

const compose = `# a comment that must survive
services:
  web:
    image: nginx:latest
    volumes:
      - app-data:/var/www/html
      - "./models:/models:ro"
    networks:
      - frontend

  # the api has no storage yet
  api:
    image: nginx:latest
    restart: always

networks:
  frontend:
    driver: bridge
`;

const parse = (text: string) => Bun.YAML.parse(text) as any;

describe('reading a compose file', () => {
  test('lists services in declaration order', () => {
    expect(composeServiceNames(compose)).toEqual(['web', 'api']);
  });

  test('lists short-syntax mounts, quoted or not', () => {
    expect(composeMounts(compose)).toEqual([
      { service: 'web', source: 'app-data', target: '/var/www/html' },
      { service: 'web', source: './models', target: '/models' },
    ]);
  });
});

describe('useVolumeInCompose', () => {
  test('replaces the entry already mounting that path, keeping its mode', () => {
    const out = useVolumeInCompose(compose, 'web', 'llm-models', '/models')!;
    expect(parse(out).services.web.volumes).toEqual(['app-data:/var/www/html', 'llm-models:/models:ro']);
    expect(parse(out).services.web.networks).toEqual(['frontend']);
    expect(out).toContain('# a comment that must survive');
  });

  test('appends to an existing list', () => {
    const out = useVolumeInCompose(compose, 'web', 'cache', '/cache')!;
    expect(parse(out).services.web.volumes).toEqual([
      'app-data:/var/www/html',
      './models:/models:ro',
      'cache:/cache',
    ]);
  });

  test('adds a volumes key to a service without one', () => {
    const out = useVolumeInCompose(compose, 'api', 'cache', '/cache', true)!;
    expect(parse(out).services.api).toEqual({
      image: 'nginx:latest',
      restart: 'always',
      volumes: ['cache:/cache:ro'],
    });
    expect(out).toContain('# the api has no storage yet');
  });

  test('declares the volume external, once', () => {
    const once = useVolumeInCompose(compose, 'api', 'cache', '/cache')!;
    expect(parse(once).volumes).toEqual({ cache: { external: true } });
    const twice = useVolumeInCompose(once, 'web', 'cache', '/cache')!;
    expect(parse(twice).volumes).toEqual({ cache: { external: true } });
  });

  test('adds to a top-level volumes block that is already there', () => {
    const withBlock = `${compose}\nvolumes:\n  app-data:\n    driver: local\n`;
    const out = useVolumeInCompose(withBlock, 'api', 'cache', '/cache')!;
    expect(parse(out).volumes).toEqual({
      'app-data': { driver: 'local' },
      cache: { external: true },
    });
  });

  test('handles a list written at its key\'s own indent', () => {
    const flush = 'services:\n  web:\n    image: x\n    volumes:\n    - ./a:/a\n    restart: always\n';
    const out = useVolumeInCompose(flush, 'web', 'b', '/b')!;
    expect(parse(out).services.web).toEqual({ image: 'x', volumes: ['./a:/a', 'b:/b'], restart: 'always' });
  });

  test('refuses what it cannot edit safely', () => {
    expect(useVolumeInCompose(compose, 'nope', 'x', '/x')).toBeNull();
    expect(useVolumeInCompose('services:\n  web:\n    volumes: [a:/a]\n', 'web', 'x', '/x')).toBeNull();
  });
});

describe('k8sVolumeSnippet', () => {
  test('names the claim as written and the Pod volume as a DNS label', () => {
    const snippet = k8sVolumeSnippet('rudder-abcdef12-Web_Models', '/models');
    expect(snippet).toContain('claimName: rudder-abcdef12-Web_Models');
    expect(snippet).toContain('- name: rudder-abcdef12-web-models');
    expect(snippet).toContain('mountPath: /models');
  });
});
