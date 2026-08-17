import { describe, expect, test } from 'bun:test';
import { classifyRequest, isAuditable } from './audit';

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
