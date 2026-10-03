import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '$lib/db';
import { applications, sessions, teams, users, workers } from '$lib/db/schema';
import { createSession } from '$lib/auth';
import {
  DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES,
  IMAGE_UPDATE_INTERVAL_ERROR,
  MAX_IMAGE_UPDATE_INTERVAL_MINUTES,
  parseImageUpdateFormSettings,
  parseImageUpdateInterval,
} from '../image-update-settings';
import { actions as createActions } from '../../routes/applications/new/+page.server';
import { actions as editActions } from '../../routes/applications/[id]/edit/+page.server';
import { GET as exportApplication } from '../../routes/api/applications/[id]/export/+server';
import { POST as importApplication } from '../../routes/api/applications/import/+server';

function form(values: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe('image update settings validation', () => {
  test('absent and empty intervals default to one hour', () => {
    for (const raw of [undefined, null, '']) {
      expect(parseImageUpdateInterval(raw)).toBe(DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES);
    }
  });

  test('accepts integer minutes within the supported bounds', () => {
    for (const raw of [1, '1', 60, '60', ' 60 ', '0060', 10080, '10080']) {
      expect(parseImageUpdateInterval(raw)).toBe(Number(raw));
    }
    expect(MAX_IMAGE_UPDATE_INTERVAL_MINUTES).toBe(7 * 24 * 60);
  });

  test('rejects fractions, partial numbers, coercions, and out-of-range values', () => {
    for (const raw of [0, -1, 10081, 1.5, NaN, Infinity, '1.5', '60minutes', '1e2',
      '0x3c', '+60', '-1', '0', '10081', ' ', true, false, [], {}, new File([], '60')]) {
      expect(parseImageUpdateInterval(raw), String(raw)).toBeNull();
    }
  });

  test('new forms are disabled by default and require an explicit true value', () => {
    expect(parseImageUpdateFormSettings(form())).toEqual({
      autoUpdateEnabled: false, autoUpdateIntervalMinutes: 60,
    });
    for (const raw of ['false', 'on', '1', 'TRUE', '']) {
      expect(parseImageUpdateFormSettings(form({ autoUpdateEnabled: raw }))?.autoUpdateEnabled).toBe(false);
    }
    expect(parseImageUpdateFormSettings(form({ autoUpdateEnabled: 'true' }))?.autoUpdateEnabled).toBe(true);
  });

  test('missing or unchanged edit fields preserve settings without writing the check clock', () => {
    const current = { autoUpdateEnabled: true, autoUpdateIntervalMinutes: 120 };
    expect(parseImageUpdateFormSettings(form(), current)).toEqual(current);
    expect(parseImageUpdateFormSettings(form({
      autoUpdateEnabled: 'true', autoUpdateIntervalMinutes: '120',
    }), current)).toEqual(current);
  });

  test('opting out or changing the interval resets the check clock', () => {
    const current = { autoUpdateEnabled: true, autoUpdateIntervalMinutes: 120 };
    expect(parseImageUpdateFormSettings(form({ autoUpdateEnabled: 'false' }), current)).toEqual({
      autoUpdateEnabled: false, autoUpdateIntervalMinutes: 120, autoUpdateLastCheckedAt: null,
    });
    expect(parseImageUpdateFormSettings(form({ autoUpdateIntervalMinutes: '' }), current)).toEqual({
      autoUpdateEnabled: true, autoUpdateIntervalMinutes: 60, autoUpdateLastCheckedAt: null,
    });
    expect(parseImageUpdateFormSettings(form({ autoUpdateIntervalMinutes: '60junk' }), current)).toBeNull();
  });
});

test('migration defaults and routing acknowledgement survive scheduling writes', () => {
  const sqlite = new Database(':memory:');
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  try {
    for (const { tag } of journal.entries.filter(({ tag }) => !tag.startsWith('0005_'))) {
      for (const statement of readFileSync(`drizzle/${tag}.sql`, 'utf8').split('--> statement-breakpoint')) {
        sqlite.run(statement);
      }
    }
    sqlite.run("INSERT INTO workers (id, name, hostname, ssh_user, podman_api_url, created_at) VALUES ('w1', 'one', 'localhost', 'root', 'http://localhost', 0), ('w2', 'two', 'localhost', 'root', 'http://localhost', 0)");
    sqlite.run("INSERT INTO applications (id, worker_id, name, created_at, updated_at) VALUES ('old', 'w1', 'old', 0, 0)");
    const migration = journal.entries.at(-1)!;
    expect(migration.tag).toBe('0005_automatic_image_updates');
    for (const statement of readFileSync(`drizzle/${migration.tag}.sql`, 'utf8').split('--> statement-breakpoint')) {
      // Executing every segment also catches empty/comment-only breakpoints.
      sqlite.run(statement);
    }
    sqlite.run("INSERT INTO applications (id, name, created_at, updated_at) VALUES ('new', 'new', 0, 0)");
    expect(sqlite.query('SELECT auto_update_enabled, auto_update_interval_minutes, auto_update_last_checked_at FROM applications ORDER BY id').all()).toEqual([
      { auto_update_enabled: 0, auto_update_interval_minutes: 60, auto_update_last_checked_at: null },
      { auto_update_enabled: 0, auto_update_interval_minutes: 60, auto_update_last_checked_at: null },
    ]);

    const worker = (id = 'w1') => sqlite.query('SELECT config_applied_hash, routing_revision FROM workers WHERE id = ?').get(id);
    sqlite.run("UPDATE workers SET config_applied_hash = 'verified', routing_revision = 7");
    sqlite.run("UPDATE applications SET auto_update_last_checked_at = 123, updated_at = 123 WHERE id = 'old'");
    expect(worker()).toEqual({ config_applied_hash: 'verified', routing_revision: 7 });
    sqlite.run("UPDATE applications SET auto_update_enabled = 1, auto_update_interval_minutes = 15, auto_update_last_checked_at = NULL WHERE id = 'old'");
    expect(worker()).toEqual({ config_applied_hash: 'verified', routing_revision: 7 });
    sqlite.run("UPDATE applications SET rate_limit_avg = 20 WHERE id = 'old'");
    expect(worker()).toEqual({ config_applied_hash: null, routing_revision: 8 });
    sqlite.run("UPDATE applications SET worker_id = 'w2' WHERE id = 'old'");
    expect(worker()).toEqual({ config_applied_hash: null, routing_revision: 9 });
    expect(worker('w2')).toEqual({ config_applied_hash: null, routing_revision: 8 });
  } finally {
    sqlite.close();
  }
});

describe('image update settings through application forms and configuration files', () => {
  const workerId = 'image-update-settings-worker';
  const teamId = 'image-update-settings-team';
  const userId = 'image-update-settings-admin';
  const auth = {
    user: { id: userId, username: userId, email: `${userId}@example.com`, role: 'admin' as const, fullName: userId },
    sessionUserId: userId,
  };
  let cookies: any;
  let editedAppId: string;
  const app = (id = editedAppId) => db.select().from(applications).where(eq(applications.id, id)).get()!;
  const request = (data: FormData) => new Request('http://localhost/applications', { method: 'POST', body: data });

  async function create(name: string, values: Record<string, string> = {}) {
    const data = form({ name, teamId, workerId, manifest: 'nginx:latest', ...values });
    try {
      return await createActions.default({ locals: { auth } as App.Locals, request: request(data) });
    } catch (error) {
      expect(error).toMatchObject({ status: 303 });
      return db.select().from(applications).where(eq(applications.name, name)).get()!;
    }
  }

  async function edit(values: Record<string, string> = {}) {
    try {
      return await editActions.default({ params: { id: editedAppId }, cookies,
        request: request(form({ name: app().name, teamId, workerId, ...values })),
      });
    } catch (error) {
      expect(error).toMatchObject({ status: 303 });
      return undefined;
    }
  }

  async function imported(name: string, config: Record<string, unknown>) {
    const response = await importApplication({ locals: { auth }, request: new Request('http://localhost/api/applications/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config, teamId, workerId }),
    }) } as any);
    const body = await response.json() as any;
    return { response, body, application: body.applicationId ? app(body.applicationId) : undefined };
  }

  beforeAll(async () => {
    const now = new Date();
    db.insert(users).values({ ...auth.user, createdAt: now, updatedAt: now }).run();
    db.insert(teams).values({ id: teamId, name: teamId, slug: teamId, createdAt: now, updatedAt: now }).run();
    db.insert(workers).values({ id: workerId, name: workerId, hostname: 'localhost', sshUser: 'root',
      podmanApiUrl: 'http://localhost:9999', createdAt: now }).run();
    const token = await createSession(userId);
    cookies = { get: () => token };
  });

  afterAll(() => {
    db.delete(applications).where(eq(applications.teamId, teamId)).run();
    db.delete(workers).where(eq(workers.id, workerId)).run();
    db.delete(teams).where(eq(teams.id, teamId)).run();
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
    db.delete(users).where(eq(users.id, userId)).run();
  });

  test('create forms stay opted out by default and save options for every application format', async () => {
    const created = await create('image-update-default') as typeof applications.$inferSelect;
    expect(created.autoUpdateEnabled).toBe(false);
    expect(created.autoUpdateIntervalMinutes).toBe(60);
    for (const type of ['single', 'compose', 'k8s']) {
      const created = await create(`image-update-${type}`, {
        type, autoUpdateEnabled: 'true', autoUpdateIntervalMinutes: '15',
      }) as typeof applications.$inferSelect;
      expect(created.autoUpdateEnabled).toBe(true);
      expect(created.autoUpdateIntervalMinutes).toBe(15);
      expect(created.autoUpdateLastCheckedAt).toBeNull();
      if (type === 'single') editedAppId = created.id;
    }
  });

  test('edit can disable, enable, and change the interval while omitted values are preserved', async () => {
    const checkedAt = new Date('2026-10-03T00:00:00Z');
    const recordCheck = () => db.update(applications).set({ autoUpdateLastCheckedAt: checkedAt }).where(eq(applications.id, editedAppId)).run();
    recordCheck();
    await edit();
    expect(app().autoUpdateEnabled).toBe(true);
    expect(app().autoUpdateIntervalMinutes).toBe(15);
    expect(app().autoUpdateLastCheckedAt).toEqual(checkedAt);
    await edit({ autoUpdateEnabled: 'false' });
    expect(app().autoUpdateEnabled).toBe(false);
    expect(app().autoUpdateLastCheckedAt).toBeNull();
    recordCheck();
    await edit({ autoUpdateEnabled: 'true' });
    expect(app().autoUpdateEnabled).toBe(true);
    expect(app().autoUpdateLastCheckedAt).toBeNull();
    recordCheck();
    await edit({ autoUpdateIntervalMinutes: '120' });
    expect(app().autoUpdateIntervalMinutes).toBe(120);
    expect(app().autoUpdateLastCheckedAt).toBeNull();
  });

  test('invalid intervals are rejected by both form actions without saving', async () => {
    const created = await create('image-update-invalid', { autoUpdateIntervalMinutes: '1.5' });
    expect(created).toMatchObject({ status: 400, data: { error: IMAGE_UPDATE_INTERVAL_ERROR } });
    expect(await edit({ autoUpdateIntervalMinutes: '120minutes' })).toMatchObject({
      status: 400, data: { error: IMAGE_UPDATE_INTERVAL_ERROR },
    });
    expect(app().autoUpdateIntervalMinutes).toBe(120);
  });

  test('export preserves options and excludes the scheduling timestamp', async () => {
    db.update(applications).set({ autoUpdateLastCheckedAt: new Date() }).where(eq(applications.id, editedAppId)).run();
    const response = await exportApplication({ params: { id: editedAppId }, cookies });
    const exported = await response.json();
    expect(exported).toMatchObject({ autoUpdateEnabled: true, autoUpdateIntervalMinutes: 120 });
    expect(exported).not.toHaveProperty('autoUpdateLastCheckedAt');
  });

  test('old imports stay disabled and imported opt-in accepts only a JSON boolean true', async () => {
    const old = await imported('image-update-import-old', { manifest: 'nginx:latest' });
    expect(old.response.status).toBe(200);
    expect(old.application).toMatchObject({ autoUpdateEnabled: false, autoUpdateIntervalMinutes: 60, autoUpdateLastCheckedAt: null });
    const enabled = await imported('image-update-import-enabled', {
      autoUpdateEnabled: true, autoUpdateIntervalMinutes: 30, autoUpdateLastCheckedAt: '2026-01-01',
    });
    expect(enabled.application).toMatchObject({ autoUpdateEnabled: true, autoUpdateIntervalMinutes: 30, autoUpdateLastCheckedAt: null });
    const truthy = await imported('image-update-import-string', { autoUpdateEnabled: 'true' });
    expect(truthy.application?.autoUpdateEnabled).toBe(false);
    const invalid = await imported('image-update-import-invalid', { autoUpdateIntervalMinutes: 0 });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toBe(IMAGE_UPDATE_INTERVAL_ERROR);
  });
});
