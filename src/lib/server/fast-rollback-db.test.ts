import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '$lib/db';
import { applications, containers, teams, workers } from '$lib/db/schema';
import { fastRollbackTargets, isAbsent } from './deploy';

/**
 * Which retained generations the application page may offer as a fast rollback.
 *
 * The distinction is not cosmetic. The history labels these "rolls back in
 * seconds" and everything else "full redeploy", and the whole value of the label
 * is that someone reaches for it in a hurry. Offering a generation whose
 * containers are no longer on the worker means the button 404s on its first
 * `startContainer` at exactly the moment nobody has time to work out why — so a
 * row that Podman cannot account for must not be advertised.
 */

const APP_ID = 'aaaaaaaa-1111-0000-0000-000000000001';
const WORKER_ID = 'dddddddd-1111-0000-0000-000000000004';

/** Generation 2 is retained and intact; generation 3 lost one of its two. */
const INTACT = 'dep-intact';
const PARTIAL = 'dep-partial';
const CURRENT = 'dep-current';

beforeAll(async () => {
  const now = new Date();
  const teamId = 'eeeeeeee-1111-0000-0000-000000000005';

  await db.insert(teams).values({
    id: teamId,
    name: 'rollback',
    slug: 'rollback',
    createdAt: now,
    updatedAt: now,
  } as any);

  await db.insert(workers).values({
    id: WORKER_ID,
    name: 'rollback-worker',
    hostname: 'rollback.example.com',
    sshPort: 22,
    sshUser: 'root',
    // Never contacted: `fastRollbackTargets` is pure database work.
    podmanApiUrl: 'https://podman-api.rollback.example.com',
    routingMode: 'http',
    status: 'online',
    createdAt: now,
    updatedAt: now,
  } as any);

  await db.insert(applications).values({
    id: APP_ID,
    teamId,
    workerId: WORKER_ID,
    name: 'rollable',
    type: 'compose',
    deploymentFormat: 'compose',
    manifest: 'services:\n  web:\n    image: nginx:1.27',
    restartPolicy: 'always',
    retainPreviousMinutes: 60,
    createdAt: now,
    updatedAt: now,
  } as any);

  const container = (over: Record<string, unknown>) => ({
    id: crypto.randomUUID(),
    applicationId: APP_ID,
    workerId: WORKER_ID,
    containerId: crypto.randomUUID().replace(/-/g, ''),
    image: 'nginx:1.27',
    generation: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  await db.insert(containers).values([
    // Serving. Not a rollback target — it is what you would roll back *from*.
    container({ name: 'rollable-web-g4', status: 'running', state: 'active', deploymentId: CURRENT }),

    // Retained and entirely present.
    container({ name: 'rollable-web-g2', status: 'exited', state: 'draining', deploymentId: INTACT }),
    container({ name: 'rollable-api-g2', status: 'exited', state: 'draining', deploymentId: INTACT }),

    // Retained, but one of the pair has gone. `missing` is what the fleet sweep
    // writes when Podman reports nothing with the row's id.
    container({ name: 'rollable-web-g3', status: 'exited', state: 'draining', deploymentId: PARTIAL }),
    container({ name: 'rollable-api-g3', status: 'missing', state: 'draining', deploymentId: PARTIAL }),
  ] as any);
});

describe('isAbsent', () => {
  test('recognises the word the fleet sweep writes for a vanished container', () => {
    expect(isAbsent('missing')).toBe(true);
  });

  test('a stopped container is present, not absent', () => {
    // The distinction the retention window depends on: `exited` is a container
    // that is there and not running, which is exactly what a fast rollback
    // restarts. Confusing the two would either offer rollbacks that cannot work
    // or refuse every rollback that can.
    for (const status of ['exited', 'running', 'created', 'paused', 'stopped', null, undefined]) {
      expect(isAbsent(status)).toBe(false);
    }
  });
});

describe('fastRollbackTargets', () => {
  test('offers a retained generation whose containers are all present', async () => {
    expect(await fastRollbackTargets(APP_ID)).toContain(INTACT);
  });

  test('does not offer a generation that has lost a container', async () => {
    // Rejected per generation rather than per container: restarting one half of
    // a two-container version is not a rollback, it is a third state.
    expect(await fastRollbackTargets(APP_ID)).not.toContain(PARTIAL);
  });

  test('does not offer the generation that is currently serving', async () => {
    expect(await fastRollbackTargets(APP_ID)).not.toContain(CURRENT);
  });

  test('offers nothing for an application with no retained generations', async () => {
    expect(await fastRollbackTargets('cccccccc-1111-0000-0000-000000000003')).toEqual([]);
  });
});
