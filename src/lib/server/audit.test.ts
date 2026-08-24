import { describe, expect, test } from 'bun:test';
import { AUDITED_READS, classifyRequest, isAuditable } from './audit';

const APP = '3f7c1e2a-9b4d-4c8e-8f1a-2d5b6c7e8f90';
const WORKER = '04cfddf7-a955-4b1c-bc88-ef03a3737f2c';
const CONTAINER = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('isAuditable', () => {
  test('skips the endpoints the worker page polls', () => {
    // These flooded Recent Activity with identical "CREATE worker" rows.
    expect(isAuditable(`/api/workers/${WORKER}/info`)).toBe(false);
    expect(isAuditable('/api/workers/check')).toBe(false);
  });

  test('skips authentication, which has its own trail', () => {
    expect(isAuditable('/api/auth/logout')).toBe(false);
  });

  test('audits everything else, including neighbouring worker routes', () => {
    expect(isAuditable(`/api/workers/${WORKER}/prune`)).toBe(true);
    expect(isAuditable(`/api/workers/${WORKER}`)).toBe(true);
    expect(isAuditable('/api/workers/provision')).toBe(true);
    expect(isAuditable('/api/applications/deploy')).toBe(true);
  });
});

describe('volume storage', () => {
  const VOLUME = 'rudder-3f7c1e2a-db-data';
  const under = (suffix = '') =>
    `/api/applications/${APP}/volumes/${VOLUME}${suffix}`;

  test('files storage operations under the volume, not the application', () => {
    // `DELETE /api/applications/:id/volumes/:name` destroys data and changes
    // nothing about the application, so it belongs with the rest of the storage
    // trail rather than among that application's deploys.
    expect(classifyRequest('DELETE', under()).resourceType).toBe('volume');
    expect(classifyRequest('POST', under('/restore')).action).toBe('RESTORE_VOLUME');
    expect(classifyRequest('POST', under('/copy')).action).toBe('COPY_VOLUME');
  });

  test('a backup is audited, though it is a GET', () => {
    // The hook records writes only, which would have left the one operation
    // that takes a volume's entire contents off the worker with no trail. The
    // exposure is a copy; the method it is spelled with says nothing about that.
    expect(classifyRequest('GET', under('/backup')).action).toBe('BACKUP_VOLUME');
    expect(AUDITED_READS.has('BACKUP_VOLUME')).toBe(true);
  });

  test('ordinary reads stay out of the trail', () => {
    // Auditing every GET would bury everything worth finding under page loads.
    expect(AUDITED_READS.has(classifyRequest('GET', under()).action)).toBe(false);
    expect(AUDITED_READS.has(classifyRequest('GET', `/api/applications/${APP}`).action)).toBe(false);
  });
});

describe('classifyRequest', () => {
  test('tells the five POSTs apart', () => {
    // The whole point: these were all recorded as CREATE.
    expect(classifyRequest('POST', '/api/applications/deploy').action).toBe('DEPLOY');
    expect(classifyRequest('POST', `/api/applications/${APP}/deployments`).action).toBe('ROLLBACK');
    expect(classifyRequest('POST', `/api/applications/${APP}/reconcile`).action).toBe('RECONCILE');
    expect(classifyRequest('PATCH', `/api/applications/${APP}/scale`).action).toBe('SCALE');
    expect(classifyRequest('POST', `/api/containers/${CONTAINER}/exec`).action).toBe('EXEC');
  });

  test('names the resource and carries its id', () => {
    expect(classifyRequest('POST', `/api/applications/${APP}/reconcile`)).toEqual({
      action: 'RECONCILE',
      resourceType: 'application',
      resourceId: APP,
    });
    expect(classifyRequest('POST', `/api/workers/${WORKER}/prune`)).toEqual({
      action: 'PRUNE',
      resourceType: 'worker',
      resourceId: WORKER,
    });
    expect(classifyRequest('POST', `/api/containers/${CONTAINER}/exec`).resourceId).toBe(CONTAINER);
  });

  test('falls back to the method on collection routes, where POST really is create', () => {
    expect(classifyRequest('POST', '/api/secrets')).toEqual({
      action: 'CREATE',
      resourceType: 'secret',
      resourceId: null,
    });
    expect(classifyRequest('PATCH', '/api/secrets').action).toBe('UPDATE');
    expect(classifyRequest('DELETE', '/api/api-keys').action).toBe('DELETE');
    expect(classifyRequest('DELETE', '/api/api-keys').resourceType).toBe('api_key');
  });

  test('a DELETE against an operation route is still a delete', () => {
    expect(classifyRequest('DELETE', `/api/applications/${APP}/webhook`).action).toBe('DELETE');
    expect(classifyRequest('POST', `/api/applications/${APP}/webhook`).action).toBe('CONFIGURE_WEBHOOK');
  });

  test('page form actions are named, not "unknown"', () => {
    // Saving the application edit form: a POST to the page, not to /api.
    expect(classifyRequest('POST', `/applications/${APP}/edit`, '?/save')).toEqual({
      action: 'SAVE',
      resourceType: 'application',
      resourceId: APP,
    });
    expect(classifyRequest('POST', '/teams', '?/create').action).toBe('CREATE');
    expect(classifyRequest('POST', `/workers/${WORKER}`, '?/delete').resourceType).toBe('worker');
  });

  test('does not mistake a route name for an id', () => {
    expect(classifyRequest('POST', '/api/applications/deploy').resourceId).toBeNull();
    expect(classifyRequest('POST', '/api/applications/import').resourceId).toBeNull();
    expect(classifyRequest('POST', '/api/workers/check').resourceId).toBeNull();
    expect(classifyRequest('POST', '/api/templates/save').resourceId).toBeNull();
  });

  test('keeps kubectl verbs recognisable', () => {
    const t = classifyRequest('DELETE', '/k8s/apis/apps/v1/namespaces/platform/deployments/web');
    expect(t.action).toBe('DELETE');
    expect(t.resourceType).toBe('k8s_deployments');
  });

  test('unknown routes degrade to the method', () => {
    expect(classifyRequest('POST', '/api/something-new')).toEqual({
      action: 'CREATE',
      resourceType: 'unknown',
      resourceId: null,
    });
  });
});
