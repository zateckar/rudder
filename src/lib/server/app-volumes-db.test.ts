import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, containers, teams, workers } from '$lib/db/schema';
import {
  assertNotSharedWithOthers,
  otherAppsUsing,
  runningContainerNames,
  type AppVolume,
  type SharedVolumeAction,
} from './app-volumes';
import { AuthorizationError } from './auth';

/**
 * The restore guard's query.
 *
 * Restoring a volume overwrites files under whatever has them open, which on a
 * database produces a corrupt store rather than the state that was backed up —
 * so the route refuses while anything is running and names what to stop. The
 * refusal is only as good as this query: a wrong column or a wrong status
 * spelling turns the guard into a no-op that reads as a guard.
 */

const APP_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_APP_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const WORKER_ID = 'dddddddd-0000-0000-0000-000000000004';

/**
 * Both applications declare `pgdata` outright, which is the hazard: a bare
 * compose volume name is not namespaced, so the two share one volume on disk.
 */
const SHARED_MANIFEST = [
  'services:',
  '  db:',
  '    image: postgres:16',
  '    volumes:',
  '      - ./data:/data',
  '      - pgdata:/var/lib/postgresql/data',
].join('\n');

beforeAll(async () => {
  const now = new Date();
  const teamId = crypto.randomUUID();
  await db.insert(teams).values({
    id: teamId,
    name: 'storage-guard',
    slug: 'storage-guard',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(workers).values({
    id: WORKER_ID,
    name: 'guard-worker',
    hostname: 'guard.example.com',
    sshPort: 22,
    sshUser: 'root',
    // Never contacted — `otherAppsUsing` is pure database work — but the column
    // is NOT NULL.
    podmanApiUrl: 'https://podman-api.guard.example.com',
    status: 'online',
    createdAt: now,
    updatedAt: now,
  } as any);

  for (const [id, name] of [
    [APP_ID, 'guarded'],
    [OTHER_APP_ID, 'neighbour'],
  ] as const) {
    await db.insert(applications).values({
      id,
      teamId,
      workerId: WORKER_ID,
      name,
      type: 'compose',
      deploymentFormat: 'compose',
      manifest: SHARED_MANIFEST,
      restartPolicy: 'always',
      createdAt: now,
      updatedAt: now,
    });
  }

  const container = (over: Record<string, unknown>) => ({
    id: crypto.randomUUID(),
    applicationId: APP_ID,
    containerId: crypto.randomUUID().replace(/-/g, ''),
    image: 'postgres:16',
    generation: 1,
    state: 'active' as const,
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  await db.insert(containers).values([
    container({ name: 'guarded-db-g1', status: 'running' }),
    container({ name: 'guarded-cache-g1', status: 'exited' }),
    container({ name: 'guarded-worker-g1', status: 'running' }),
    // Another application's running container must not hold this one back.
    container({ applicationId: OTHER_APP_ID, name: 'neighbour-db-g1', status: 'running' }),
  ] as any);
});

describe('runningContainerNames', () => {
  test('names every running container of the application', async () => {
    // Named, not counted: the refusal has to tell the user what to stop.
    expect((await runningContainerNames(APP_ID)).sort()).toEqual([
      'guarded-db-g1',
      'guarded-worker-g1',
    ]);
  });

  test('a container that is not running does not block a restore', async () => {
    expect(await runningContainerNames(APP_ID)).not.toContain('guarded-cache-g1');
  });

  test('scoped to the application, so a neighbour cannot block it', async () => {
    expect(await runningContainerNames(OTHER_APP_ID)).toEqual(['neighbour-db-g1']);
  });

  test('an application with nothing running is clear to restore', async () => {
    expect(await runningContainerNames('cccccccc-0000-0000-0000-000000000003')).toEqual([]);
  });
});

/**
 * The shared-volume delete guard.
 *
 * `pgdata:/data` in a compose file produces a volume literally called `pgdata`,
 * not scoped to the application — so "delete this application's volume" can mean
 * deleting another team's database. The guard names the other application rather
 * than warning vaguely, which it can only do by computing it.
 */
describe('otherAppsUsing', () => {
  const worker = { id: WORKER_ID, name: 'guard-worker', hostname: 'guard.example.com' } as any;

  test('names the other application sharing an un-namespaced volume', async () => {
    expect(await otherAppsUsing('pgdata', APP_ID, worker)).toEqual(['neighbour']);
    // Symmetric: neither is privileged over the other.
    expect(await otherAppsUsing('pgdata', OTHER_APP_ID, worker)).toEqual(['guarded']);
  });

  test('an app-scoped volume is never reported as shared', async () => {
    // `rudder-<app8>-<service>-<base>` can only belong to one application, which
    // is the whole point of the prefix — so this must not refuse the delete.
    expect(await otherAppsUsing('rudder-aaaaaaaa-db-data', APP_ID, worker)).toEqual([]);
  });

  test('the application itself is not counted as another user', async () => {
    // It declares `pgdata` too; counting itself would make every shared volume
    // permanently undeletable.
    expect(await otherAppsUsing('pgdata', APP_ID, worker)).not.toContain('guarded');
  });

  test('a volume nothing declares is free to delete', async () => {
    expect(await otherAppsUsing('unreferenced', APP_ID, worker)).toEqual([]);
  });
});

/**
 * The guard every operation that touches contents goes through.
 *
 * Being *declared* is not ownership. A manifest is authored by an ordinary team
 * member and a non-relative compose source is passed through verbatim, so an
 * application can name `pgdata` — or another team's `rudder-<app8>-pgdata` —
 * and have it resolve as one of its own volumes. Delete was the only operation
 * that asked; backup read the contents out, and restore force-removed and
 * recreated the volume while checking only the *asking* application's
 * containers for whether anything was running.
 */
describe('assertNotSharedWithOthers', () => {
  const worker = { id: WORKER_ID, name: 'guard-worker', hostname: 'guard.example.com' } as any;
  const app = { id: APP_ID, name: 'guarded' } as any;

  const volume = (over: Partial<AppVolume>): AppVolume => ({
    name: 'pgdata',
    label: 'pgdata',
    origin: 'shared',
    declared: true,
    present: true,
    sizeBytes: 1024,
    mountpoint: '/var/lib/containers/storage/volumes/pgdata/_data',
    targets: [],
    registryId: null,
    sizeLimit: null,
    copies: [],
    ...over,
  });

  const refusal = async (action: SharedVolumeAction, v = volume({})) => {
    try {
      await assertNotSharedWithOthers(app, worker, v, action);
    } catch (e) {
      return e as AuthorizationError;
    }
    return null;
  };

  test('refuses every operation that reads or writes a shared volume', async () => {
    // Reads included. A backup or a copy of the neighbour's database is the
    // whole of the exposure, and no less so for being read-only.
    for (const action of ['delete', 'restore', 'back up', 'copy'] as const) {
      const error = await refusal(action);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error!.statusCode).toBe(409);
      // Named, so the user can go and rename it in the right manifest.
      expect(error!.message).toContain('"neighbour"');
      expect(error!.message).toContain('guard-worker');
    }
  });

  test('says what the operation would have done to the other application', async () => {
    // One refusal reused across four verbs would read as boilerplate; the point
    // is that the user understands whose data was at stake and how.
    expect((await refusal('delete'))!.message).toContain('delete their data too');
    expect((await refusal('restore'))!.message).toContain('overwrite their data');
    expect((await refusal('back up'))!.message).toContain('hand you their data');
    expect((await refusal('copy'))!.message).toContain('copy of their data');
  });

  test('allows a volume whose name proves it belongs to this application', async () => {
    // `app-scoped` and `registry` names are derived from the application id, so
    // no other application can be behind one — and the database is not even
    // consulted.
    for (const origin of ['app-scoped', 'registry'] as const) {
      expect(
        await refusal('delete', volume({ origin, name: 'rudder-aaaaaaaa-db-data' })),
      ).toBeNull();
    }
  });

  test('allows a shared volume no other application declares', async () => {
    // The residual gap, and deliberately so: there is no ownership record for a
    // name Rudder did not generate, so "nobody else claims it" is the most that
    // can be asked.
    expect(await refusal('restore', volume({ name: 'unreferenced' }))).toBeNull();
  });

  test('a copy is app-scoped by construction and never blocked', async () => {
    // `rudder-copy-<app8>-…` is generated here, so a copy can hold no other
    // application's data and deleting one is always the caller's own business.
    expect(
      await refusal(
        'delete',
        volume({ origin: 'app-scoped', name: 'rudder-copy-aaaaaaaa-pgdata-1700000000000' }),
      ),
    ).toBeNull();
  });
});
