import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// The plain-HTTP path below needs ALLOW_INSECURE_PODMAN, which `test/preload.ts`
// sets: `$lib/server/env` parses the environment once at import time and the
// suite shares a module registry, so setting it here would only work when this
// file happened to import it first.
import { evictPodmanClient, getRestPodmanClient, withPodman } from './podman-client';

/**
 * One client per worker, and one TLS session per worker with it.
 *
 * Every caller used to build its own client and destroy it when it was done, so
 * the keep-alive agent was emptied before anything could be drawn from it and
 * every call to a worker paid a fresh handshake. These cover the two halves of
 * the fix: the same worker gets the same client back, and a client that a
 * caller has "destroyed" still has its connection.
 *
 * Plain HTTP, because what is being asserted is socket reuse by the agent, and
 * the certificate handling above it is the same either way.
 */

/** Sockets the server has seen a request arrive on, in order. */
let seen: Socket[] = [];
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.socket);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function workerRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `worker-${id}`,
    hostname: '127.0.0.1',
    sshPort: 22,
    sshUser: 'root',
    podmanApiUrl: baseUrl,
    podmanCaCert: null,
    podmanClientCert: null,
    podmanClientKey: null,
    status: 'online',
    ...overrides,
  } as any;
}

describe('the per-worker client cache', () => {
  test('hands the same client back for the same worker', () => {
    const worker = workerRow('cache-same');
    try {
      // A second row object, as every caller has: they each read the worker
      // from the database, so identity of the row proves nothing.
      expect(getRestPodmanClient(worker)).toBe(getRestPodmanClient(workerRow('cache-same')));
    } finally {
      evictPodmanClient('cache-same');
    }
  });

  test('different workers get different clients', () => {
    try {
      expect(getRestPodmanClient(workerRow('cache-a'))).not.toBe(
        getRestPodmanClient(workerRow('cache-b')),
      );
    } finally {
      evictPodmanClient('cache-a');
      evictPodmanClient('cache-b');
    }
  });

  test('rotated credentials replace the client', () => {
    try {
      const before = getRestPodmanClient(workerRow('cache-rotate'));
      const after = getRestPodmanClient(
        workerRow('cache-rotate', { podmanClientCert: 'a-new-certificate' }),
      );
      // Sockets authenticated with the old certificate must not be reused, so
      // this must be a different client and not the cached one.
      expect(after).not.toBe(before);
    } finally {
      evictPodmanClient('cache-rotate');
    }
  });

  test('eviction forces a rebuild', () => {
    const before = getRestPodmanClient(workerRow('cache-evict'));
    evictPodmanClient('cache-evict');
    try {
      expect(getRestPodmanClient(workerRow('cache-evict'))).not.toBe(before);
    } finally {
      evictPodmanClient('cache-evict');
    }
  });

  test('a second call reuses the first call’s socket', async () => {
    seen = [];
    const worker = workerRow('cache-keepalive');
    try {
      await withPodman(worker, (c) => c.listContainers(true));
      await withPodman(worker, (c) => c.listContainers(true));

      expect(seen.length).toBe(2);
      // The whole point: before the cache, the agent was destroyed between
      // these two and the second call paid a fresh connection.
      expect(seen[0]).toBe(seen[1]);
    } finally {
      evictPodmanClient('cache-keepalive');
    }
  });

  test('destroy() by a caller does not close the shared connection', async () => {
    seen = [];
    const worker = workerRow('cache-destroy');
    try {
      const client = getRestPodmanClient(worker);
      await client.listContainers(true);

      // ~30 call sites do this in a `finally`, from when each of them owned an
      // agent. On a pooled client it has to be a release, not a teardown.
      client.destroy();

      await withPodman(worker, (c) => c.listContainers(true));
      expect(seen.length).toBe(2);
      expect(seen[0]).toBe(seen[1]);
    } finally {
      evictPodmanClient('cache-destroy');
    }
  });
});
