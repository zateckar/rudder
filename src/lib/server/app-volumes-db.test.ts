import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, containers, teams, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
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

  test('allows a name Rudder did not generate that no other application declares', async () => {
    // The residual gap, and now the whole of it: a volume created by hand on the
    // worker carries no owner in its name, so "nobody else claims it" really is
    // the most that can be asked.
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

/**
 * The other half of the guard: a name Rudder generated for a *different*
 * application.
 *
 * `assertNotSharedWithOthers` asks the worker whether anyone else declares the
 * volume, which is the best available answer for a bare `pgdata` and the wrong
 * question entirely for `rudder-<other8>-db-data`. Three ordinary situations
 * answer "nobody declares this" about data that is unambiguously somebody else's:
 * a volume the neighbour stopped mounting when its manifest changed, a copy the
 * neighbour took (nothing ever declares a copy), and — for as long as the
 * neighbour's manifest does not parse — everything the neighbour owns, because
 * `otherAppsUsing` swallows the parse error by design.
 *
 * The name settles all three without a lookup, which is why this is asserted
 * separately from the shared case rather than folded into it.
 */
describe('assertNotSharedWithOthers, on another application\'s volume', () => {
  const worker = { id: WORKER_ID, name: 'guard-worker', hostname: 'guard.example.com' } as any;
  const app = { id: APP_ID, name: 'guarded' } as any;

  const foreign = (name: string): AppVolume => ({
    name,
    label: name,
    origin: 'foreign',
    declared: true,
    present: true,
    sizeBytes: 4096,
    mountpoint: null,
    targets: [],
    registryId: null,
    sizeLimit: null,
    copies: [],
  });

  const refusalFor = async (name: string, action: SharedVolumeAction) => {
    try {
      await assertNotSharedWithOthers(app, worker, foreign(name), action);
    } catch (e) {
      return e as AuthorizationError;
    }
    return null;
  };

  test('refuses every operation on a neighbour\'s leftover volume', async () => {
    // `otherAppsUsing` says nobody declares it — the neighbour's manifest moved
    // on — while the data is still there and still theirs.
    expect(await otherAppsUsing('rudder-bbbbbbbb-db-old', APP_ID, worker)).toEqual([]);

    for (const action of ['delete', 'restore', 'back up', 'copy'] as const) {
      const error = await refusalFor('rudder-bbbbbbbb-db-old', action);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error!.statusCode).toBe(409);
      // Names the owner, so the refusal is diagnosable rather than mysterious.
      expect(error!.message).toContain('bbbbbbbb');
    }
  });

  test('refuses every operation on a neighbour\'s copy', async () => {
    const theirCopy = 'rudder-copy-bbbbbbbb-db-data-1700000000000';
    expect(await otherAppsUsing(theirCopy, APP_ID, worker)).toEqual([]);

    for (const action of ['delete', 'restore', 'back up', 'copy'] as const) {
      expect((await refusalFor(theirCopy, action))!.statusCode).toBe(409);
    }
  });

  test('still says what the operation would have done', async () => {
    expect((await refusalFor('rudder-bbbbbbbb-db-old', 'back up'))!.message).toContain(
      'hand you their data',
    );
    expect((await refusalFor('rudder-bbbbbbbb-db-old', 'delete'))!.message).toContain(
      'delete their data too',
    );
  });

  test('does not consult the database, so a broken manifest cannot weaken it', async () => {
    // `otherAppsUsing` cannot see through an unparseable manifest and must not
    // block on one, so a neighbour with a YAML typo used to lose protection for
    // every volume it owns. Nothing here asks.
    const before = await db
      .select()
      .from(applications)
      .where(eq(applications.id, OTHER_APP_ID))
      .get();

    await db
      .update(applications)
      .set({ manifest: 'services:\n  db:\n   {{{ not yaml' })
      .where(eq(applications.id, OTHER_APP_ID));
    try {
      expect(await otherAppsUsing('pgdata', APP_ID, worker)).toEqual([]);
      expect((await refusalFor('rudder-bbbbbbbb-db-data', 'back up'))!.statusCode).toBe(409);
    } finally {
      await db
        .update(applications)
        .set({ manifest: before!.manifest })
        .where(eq(applications.id, OTHER_APP_ID));
    }
  });
});
