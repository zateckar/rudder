import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApplication, route } from '#lib/server/auth.ts';
import { getTask, latestTask, operationView } from '#lib/server/application-operations.ts';

export const GET: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const id = event.url.searchParams.get('id');
  const task = id ? getTask(id) : latestTask(application.id);
  const headers = { 'Cache-Control': 'no-store' };
  if (id && task?.applicationId !== application.id) {
    return json({ error: 'Operation not found' }, { status: 404, headers });
  }
  return json({ operation: task ? operationView(task) : null }, { headers });
});
