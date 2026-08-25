import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPodmanClient, PodmanApiError, type PodmanClient } from './podman';

/**
 * Removing a container that is already gone.
 *
 * This is the decision behind a production incident. `reapContainers` treats a
 * failed removal as a reason to keep the `containers` row — deliberately, because
 * the row is what reserves the host port, and dropping it while the container is
 * still bound hands that port to the next deploy. But it also treated *"there is
 * no such container"* as a failure, and that combination cannot terminate: the
 * generation sweep asked Podman to remove a container that did not exist, took
 * the refusal as a failure, kept the row, and did the same thing again on the
 * next metrics cycle. Forever. The row held a host port out of the allocator,
 * showed up on the application page as a second container, was offered as a
 * fast-rollback target that could not work, and could not be cleared from any
 * interface — the manual remove endpoint failed in exactly the same way.
 *
 * The counterweight is `removeVolume`, which read a bare 404 as "already gone"
 * and was wrong: Podman serves the libpod volume API only under a version
 * prefix, so the 404 meant the *route* was missing and every delete reported
 * success while deleting nothing (see `podman-volumes.test.ts`). So the status
 * alone is not the test. These cases pin both directions: accept the 404 that
 * names a missing container, reject the one that does not.
 */

/** Container ids the stub worker holds. */
let store = new Set<string>();
/** Whether the stub serves the container routes at all, for the missing-route case. */
let servesRoutes = true;

let server: ReturnType<typeof Bun.serve>;
let client: PodmanClient;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      // A worker whose container routes are not where we are looking. Podman
      // answers an unknown route with Go's plain not-found — no JSON, and
      // crucially no mention of a container.
      if (!servesRoutes) return new Response('404 page not found\n', { status: 404 });

      const match = /^\/containers\/([^/]+)$/.exec(path);
      if (match && request.method === 'DELETE') {
        const id = decodeURIComponent(match[1]);
        if (!store.has(id)) {
          // Podman's actual wording for a container it does not have.
          return json(404, {
            cause: 'no such container',
            message: `no container with name or ID "${id}" found: no such container`,
            response: 404,
          });
        }
        if (id === 'held') {
          return json(409, { message: 'container is paused, cannot remove without force' });
        }
        store.delete(id);
        return new Response('', { status: 204 });
      }

      return new Response('404 page not found\n', { status: 404 });
    },
  });

  client = createPodmanClient({
    apiUrl: `http://localhost:${server.port}`,
  } as any);
});

afterAll(() => {
  client?.destroy?.();
  server?.stop(true);
});

describe('PodmanApiError.isMissingContainer', () => {
  test('accepts the 404 Podman gives for a container it does not have', () => {
    const error = PodmanApiError.fromResponse(
      404,
      JSON.stringify({
        cause: 'no such container',
        message: 'no container with name or ID "abc123" found: no such container',
      }),
    );
    expect(error.isMissingContainer()).toBe(true);
  });

  test("accepts Docker's wording for the same thing", () => {
    // The compat API is what Rudder talks to, and a Docker-compatible runtime
    // words it differently.
    const error = PodmanApiError.fromResponse(404, JSON.stringify({ message: 'No such container: abc123' }));
    expect(error.isMissingContainer()).toBe(true);
  });

  test('rejects the 404 that means the route is missing', () => {
    // The `removeVolume` trap. Accepting this would delete the row of a
    // container that is still running and still holding its host port.
    expect(PodmanApiError.fromResponse(404, '404 page not found\n').isMissingContainer()).toBe(false);
    expect(
      PodmanApiError.fromResponse(404, JSON.stringify({ message: 'Not Found' })).isMissingContainer(),
    ).toBe(false);
  });

  test('rejects every status that is not a 404', () => {
    // A 409 is a container that exists and will not go quietly. Reading it as
    // "already gone" would drop the row of something still on the worker.
    for (const status of [409, 500, 502, 200]) {
      const error = PodmanApiError.fromResponse(status, JSON.stringify({ message: 'no such container' }));
      expect(error.isMissingContainer()).toBe(false);
    }
  });
});

describe('ensureContainerRemoved', () => {
  test('removes a container that is there, and reports that it did', async () => {
    store = new Set(['live1']);
    servesRoutes = true;
    expect(await client.ensureContainerRemoved('live1', true)).toBe(true);
    expect(store.has('live1')).toBe(false);
  });

  test('succeeds on a container that is already gone, and says nothing was removed', async () => {
    // The fix. Before it, this threw — and the caller kept a row it could never
    // get rid of.
    store = new Set();
    servesRoutes = true;
    expect(await client.ensureContainerRemoved('vanished', true)).toBe(false);
  });

  test('is idempotent, so a retry after a lost response still settles', async () => {
    store = new Set(['twice']);
    servesRoutes = true;
    expect(await client.ensureContainerRemoved('twice', true)).toBe(true);
    expect(await client.ensureContainerRemoved('twice', true)).toBe(false);
  });

  test('still throws when the container exists and cannot be removed', async () => {
    // Must stay a failure: the caller keeps the row, so the host port the
    // container is still bound to stays reserved.
    store = new Set(['held']);
    servesRoutes = true;
    await expect(client.ensureContainerRemoved('held', false)).rejects.toThrow();
  });

  test('still throws when the container route is not there', async () => {
    // Not evidence about any container. Swallowing it would report a fleet-wide
    // misconfiguration as a tidy sweep and quietly orphan every container.
    store = new Set(['real']);
    servesRoutes = false;
    await expect(client.ensureContainerRemoved('real', true)).rejects.toThrow();
  });
});
