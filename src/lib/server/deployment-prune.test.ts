import { describe, expect, test } from 'bun:test';
import { imagesForRef, planPrune, type PruneDeployment, type WorkerImage } from './deployment-prune';

const dep = (version: number, over: Partial<PruneDeployment> = {}): PruneDeployment => ({
  id: `d${version}`,
  version,
  status: 'succeeded',
  image: 'nginx:latest',
  imageDigest: null,
  ...over,
});

const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const image = (id: string, over: Partial<WorkerImage> = {}): WorkerImage => ({
  Id: id,
  RepoTags: [],
  RepoDigests: [],
  Size: 100,
  ...over,
});

const base = {
  withContainers: new Set<string>(),
  imagesInUse: new Set<string>(),
  otherReferences: [] as string[],
};

describe('imagesForRef', () => {
  const images = [
    image('sha256:aaa', {
      RepoTags: ['docker.io/library/nginx:latest'],
      RepoDigests: [`docker.io/library/nginx@${digest(1)}`],
    }),
    image('bbb', { RepoTags: ['localhost/rudder/web:latest'] }),
  ];

  test('matches a tag however it is spelled', () => {
    expect(imagesForRef('nginx', images)).toEqual(['aaa']);
    expect(imagesForRef('nginx:latest', images)).toEqual(['aaa']);
    expect(imagesForRef('docker.io/library/nginx:latest', images)).toEqual(['aaa']);
    expect(imagesForRef('nginx:1.27', images)).toEqual([]);
  });

  test('matches a digest by the digest alone', () => {
    expect(imagesForRef(`nginx@${digest(1)}`, images)).toEqual(['aaa']);
    expect(imagesForRef(`nginx@${digest(2)}`, images)).toEqual([]);
  });

  test('matches a locally built image without its localhost/ prefix', () => {
    expect(imagesForRef('rudder/web:latest', images)).toEqual(['bbb']);
  });
});

describe('planPrune', () => {
  test('keeps the newest N and prunes the rest, newest first', () => {
    const plan = planPrune({
      ...base,
      deployments: [dep(1), dep(2), dep(3), dep(4)],
      keep: 2,
      images: [],
    });
    expect(plan.deployments.map((d) => d.version)).toEqual([2, 1]);
    expect(plan.keptAnyway).toEqual([]);
  });

  test('never prunes the version serving traffic, even past the cut-off', () => {
    // v3 and v4 failed; v2 is what runs.
    const plan = planPrune({
      ...base,
      deployments: [dep(1), dep(2), dep(3, { status: 'failed' }), dep(4, { status: 'failed' })],
      keep: 1,
      images: [],
    });
    expect(plan.keptAnyway).toEqual([{ id: 'd2', version: 2, reason: 'current' }]);
    expect(plan.deployments.map((d) => d.version)).toEqual([3, 1]);
  });

  test('keeps a retained generation and an unfinished deploy', () => {
    const plan = planPrune({
      ...base,
      withContainers: new Set(['d2']),
      deployments: [dep(1, { status: 'pending' }), dep(2), dep(3)],
      keep: 1,
      images: [],
    });
    expect(plan.keptAnyway.map((k) => [k.version, k.reason])).toEqual([
      [2, 'containers'],
      [1, 'in progress'],
    ]);
    expect(plan.deployments).toEqual([]);
  });

  test('never keeps fewer than one', () => {
    const plan = planPrune({ ...base, deployments: [dep(1), dep(2)], keep: 0, images: [] });
    expect(plan.deployments.map((d) => d.version)).toEqual([1]);
  });

  test('removes an image only a pruned deployment pinned', () => {
    const images = [
      image('old', { RepoDigests: [`docker.io/library/nginx@${digest(1)}`], Size: 300 }),
      image('new', {
        RepoTags: ['docker.io/library/nginx:latest'],
        RepoDigests: [`docker.io/library/nginx@${digest(2)}`],
      }),
    ];
    const plan = planPrune({
      ...base,
      deployments: [
        dep(1, { imageDigest: `nginx@${digest(1)}` }),
        dep(2, { imageDigest: `nginx@${digest(2)}` }),
      ],
      keep: 1,
      images,
    });
    // `nginx:latest` on the old row resolves to the *new* image, which the kept
    // row also names — so only the digest-matched old image goes.
    expect(plan.images).toEqual([{ id: 'old', refs: [`nginx@${digest(1)}`], sizeBytes: 300 }]);
    expect(plan.reclaimableBytes).toBe(300);
  });

  test('keeps an image any container on the worker uses', () => {
    const plan = planPrune({
      ...base,
      imagesInUse: new Set(['sha256:old']),
      deployments: [dep(1, { image: 'redis:7' }), dep(2)],
      keep: 1,
      images: [image('old', { RepoTags: ['docker.io/library/redis:7'] })],
    });
    expect(plan.deployments).toHaveLength(1);
    expect(plan.images).toEqual([]);
  });

  test('keeps an image another application on the worker deployed', () => {
    const plan = planPrune({
      ...base,
      otherReferences: ['redis:7'],
      deployments: [dep(1, { image: 'redis:7' }), dep(2)],
      keep: 1,
      images: [image('old', { RepoTags: ['docker.io/library/redis:7'] })],
    });
    expect(plan.images).toEqual([]);
  });

  test('reads every service of a multi-service digest record', () => {
    const images = [
      image('web', { RepoDigests: [`ghcr.io/acme/web@${digest(3)}`], Size: 10 }),
      image('db', { RepoDigests: [`docker.io/library/postgres@${digest(4)}`], Size: 20 }),
    ];
    const plan = planPrune({
      ...base,
      deployments: [
        dep(1, {
          image: 'ghcr.io/acme/web:1',
          imageDigest: JSON.stringify({
            db: `postgres@${digest(4)}`,
            web: `ghcr.io/acme/web@${digest(3)}`,
          }),
        }),
        dep(2, { image: 'ghcr.io/acme/web:2' }),
      ],
      keep: 1,
      images,
    });
    expect(plan.images.map((i) => i.id)).toEqual(['db', 'web']);
    expect(plan.reclaimableBytes).toBe(30);
  });
});
