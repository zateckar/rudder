import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, containers, teams, workers } from '$lib/db/schema';
import { otherAppsUsing, runningContainerNames } from './app-volumes';

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
