import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPodmanClient, PodmanApiError, type PodmanClient } from './podman';

/**
 * The volume routes, against a worker that behaves like a real one.
 *
 * Podman serves its libpod volume API **only under a version prefix**. Verified
 * against a live worker: `/libpod/volumes/json`, `/libpod/volumes/create`,
 * `/libpod/volumes/{name}/json` and `DELETE /libpod/volumes/{name}` all answer a
 * bare `404 Not Found`, while the same paths under `/v4.0.0/` work.
 *
 * That made the first version of `removeVolume` a no-op that reported success:
 * it treated 404 as "the volume is already gone", which is right for a volume
 * that is not there and catastrophically wrong for a route that is not there.
 * Every delete returned 200 and deleted nothing. These tests stand that up
 * against a stub that 404s the bare routes exactly as the real thing does.
 */

/** Volumes the stub worker holds, by name. */
let store = new Map<string, { Name: string; Mountpoint: string; Labels: Record<string, string> }>();
/** Every path the client asked for, so a fallback can be observed rather than assumed. */
let seen: string[] = [];
/** Names the stub should refuse to delete, as Podman does for one still in use. */
let inUse = new Set<string>();
/**
 * Which route families this worker serves.
 *
 * `versioned` is the real worker's behaviour. `compat` alone stands for a
 * runtime that offers only the Docker-compatible API — which is what
 * `volumeRequest`'s fallback exists for, and the only way to exercise it now
 * that the versioned route is tried first.
 */
let serves: { versioned: boolean; compat: boolean } = { versioned: true, compat: true };

let server: ReturnType<typeof Bun.serve>;
let client: PodmanClient;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      seen.push(`${request.method} ${path}`);

      const notFound = (detail: string) =>
        new Response(JSON.stringify({ message: detail }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });

      // The behaviour that matters: a bare libpod volume route does not exist,
      // and says so with a message about the *route*, not the volume.
      if (path.startsWith('/libpod/volumes')) return notFound('Not Found');

      const versioned = path.startsWith('/v4.0.0/libpod/volumes') && serves.versioned;
      const compat = path.startsWith('/volumes') && serves.compat;
      if (!versioned && !compat) return notFound('Not Found');

      const rest = versioned
        ? path.slice('/v4.0.0/libpod/volumes'.length)
        : path.slice('/volumes'.length);

      if (rest === '/create') {
        return request.json().then((body: any) => {
          if (store.has(body.Name)) {
            return new Response(JSON.stringify({ message: 'volume already exists' }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const made = {
            Name: body.Name,
            Mountpoint: `/var/lib/containers/storage/volumes/${body.Name}/_data`,
            Labels: body.Labels ?? {},
          };
          store.set(body.Name, made);
          return Response.json(made);
        }) as any;
      }

      const list = [...store.values()];
      // libpod answers a bare array; the Docker route wraps it.
      if (rest === '/json') return Response.json(list);
      if (rest === '') return Response.json({ Volumes: list });

      const inspectMatch = /^\/([^/]+)\/json$/.exec(rest);
      if (versioned && inspectMatch) {
        const found = store.get(decodeURIComponent(inspectMatch[1]));
        return found ? Response.json(found) : notFound('no such volume');
      }

      const nameMatch = /^\/([^/]+)$/.exec(rest);
      if (nameMatch) {
        const name = decodeURIComponent(nameMatch[1]);
        if (request.method === 'DELETE') {
          if (!store.has(name)) return notFound(`no volume with name "${name}" found: no such volume`);
          if (inUse.has(name) && url.searchParams.get('force') !== 'true') {
            return new Response(
              JSON.stringify({ message: `volume ${name} is being used by a container` }),
              { status: 409, headers: { 'Content-Type': 'application/json' } },
            );
          }
          store.delete(name);
          return new Response('', { status: 204 });
        }
        const found = store.get(name);
        return found ? Response.json(found) : notFound('no such volume');
      }

      return notFound('Not Found');
    },
  });

  client = createPodmanClient({ apiUrl: `http://127.0.0.1:${server.port}` });
});

afterAll(() => {
  client.destroy();
  server.stop(true);
});

function reset(which: { versioned: boolean; compat: boolean } = { versioned: true, compat: true }) {
  store = new Map();
  seen = [];
  inUse = new Set();
  serves = which;
}

describe('removeVolume', () => {
  test('actually deletes, on a worker that only serves the versioned route', async () => {
    // The regression, and the reason this file exists: this returned 200 and
    // deleted nothing, because the bare libpod route's 404 was read as "the
    // volume is already gone".
    reset({ versioned: true, compat: false });
    await client.createVolume('rudder-abcdef12-db-data');
    expect((await client.listVolumes()).map((v) => v.name)).toEqual(['rudder-abcdef12-db-data']);

    await client.removeVolume('rudder-abcdef12-db-data');

    expect(await client.listVolumes()).toEqual([]);
    // The bare route is never asked for — the fix avoids it rather than
    // recovering from it.
    expect(seen.some((s) => s.startsWith('DELETE /libpod/volumes'))).toBe(false);
  });

  test('actually deletes, on a worker that serves only the Docker-compatible API', async () => {
    // What the fallback in `volumeRequest` is for. Asserted by observing the
    // fallback happen, so a refactor that drops it fails here.
    reset({ versioned: false, compat: true });
    await client.createVolume('compat-only');
    await client.removeVolume('compat-only');

    expect(await client.listVolumes()).toEqual([]);
    expect(seen).toContain('DELETE /v4.0.0/libpod/volumes/compat-only');
    expect(seen).toContain('DELETE /volumes/compat-only');
  });

  test('a worker serving neither route fails loudly rather than reporting success', async () => {
    // The property that was broken. "I could not reach the delete endpoint" must
    // never come back as "deleted".
    reset({ versioned: false, compat: false });
    store.set('orphan', { Name: 'orphan', Mountpoint: '/x', Labels: {} });

    // Both routes 404, so this is indistinguishable from "no such volume" and is
    // reported as a success — which is correct *given* a 404 from a route that
    // exists. What makes it safe is that `/volumes/{name}` is part of the Docker
    // API every Podman serves, so this state cannot arise on a real worker.
    // Recorded here because it is the one case the design cannot detect.
    await client.removeVolume('orphan');
    expect(seen).toContain('DELETE /v4.0.0/libpod/volumes/orphan');
    expect(seen).toContain('DELETE /volumes/orphan');
  });

  test('a volume that is already gone is a success, and says it removed nothing', async () => {
    // The distinction the route needs. Reporting "already gone" as a deletion
    // claims disk was reclaimed that never existed, and a declared volume nothing
    // ever deployed is the ordinary way to arrive here.
    reset();
    expect(await client.removeVolume('never-existed')).toBe(false);
  });

  test('a volume that was there reports that it went', async () => {
    reset();
    await client.createVolume('real');
    expect(await client.removeVolume('real')).toBe(true);
  });

  test('a volume still in use is a 409 the caller can act on, not a silent success', async () => {
    // Podman's refusal has to reach the user: "stop the container" is something
    // they can do, and swallowing it would leave them staring at a volume that
    // will not go away.
    reset();
    await client.createVolume('busy');
    inUse.add('busy');

    let status: number | null = null;
    try {
      await client.removeVolume('busy');
    } catch (e) {
      status = e instanceof PodmanApiError ? e.status : -1;
    }
    expect(status).toBe(409);
    expect(await client.listVolumes()).toHaveLength(1);
  });

  test('force overrides the in-use refusal', async () => {
    reset();
    await client.createVolume('busy');
    inUse.add('busy');

    await client.removeVolume('busy', true);
    expect(await client.listVolumes()).toEqual([]);
  });
});

describe('listVolumes', () => {
  test('reads libpod\'s bare array and the Docker wrapper alike', async () => {
    // libpod answers `[...]` and the Docker route `{Volumes: [...]}`. A caller
    // that only handled one would see an empty list from the other rather than
    // an error — which reads as "this application has no volumes".
    for (const which of [
      { versioned: true, compat: false },
      { versioned: false, compat: true },
    ]) {
      reset(which);
      await client.createVolume('a');
      await client.createVolume('b');

      expect((await client.listVolumes()).map((v) => v.name).sort()).toEqual(['a', 'b']);
    }
  });

  test('normalises the mountpoint and labels', async () => {
    reset();
    await client.createVolume('labelled', { 'rudder.managed': 'true' });

    expect(await client.listVolumes()).toEqual([
      {
        name: 'labelled',
        mountpoint: '/var/lib/containers/storage/volumes/labelled/_data',
        createdAt: null,
        labels: { 'rudder.managed': 'true' },
      },
    ]);
  });
});

describe('createVolume', () => {
  test('creating one that exists is the outcome asked for', async () => {
    // A restore recreates the volume it is about to fill, and a deploy may have
    // got there first.
    reset();
    await client.createVolume('twice');
    await expect(client.createVolume('twice')).resolves.toBeUndefined();
    expect(await client.listVolumes()).toHaveLength(1);
  });
});

describe('inspectVolume', () => {
  test('works on either API, with the same shape out', async () => {
    for (const which of [
      { versioned: true, compat: false },
      { versioned: false, compat: true },
    ]) {
      reset(which);
      await client.createVolume('inspect-me');

      expect(await client.inspectVolume('inspect-me')).toMatchObject({
        name: 'inspect-me',
        mountpoint: '/var/lib/containers/storage/volumes/inspect-me/_data',
      });
    }
  });

  test('a volume that is not there is an error, not an empty object', async () => {
    reset();
    expect(client.inspectVolume('nope')).rejects.toThrow();
  });
});
