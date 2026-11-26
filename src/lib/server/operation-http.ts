import { json } from '@sveltejs/kit';
import { launchTask, OperationBusy, operationView, type TaskInit, type TaskOutcome, type TaskWork } from './application-operations';

export async function operationResponse(
  request: Request,
  init: TaskInit,
  work: TaskWork,
  finish: (outcome: TaskOutcome, operationId: string) => Response,
  actorOnly = false,
) {
  const respondAsync = request.headers.get('prefer')?.split(',').some((value) => value.trim() === 'respond-async');
  try {
    const { task, completion } = launchTask(init, work);
    if (respondAsync) {
      return json({ operation: operationView(task) }, {
        status: 202, headers: { 'Preference-Applied': 'respond-async', 'Cache-Control': 'no-store' },
      });
    }
    return finish(await completion, task.id);
  } catch (error) {
    if (!(error instanceof OperationBusy)) throw error;
    if (actorOnly && error.task.startedBy !== init.startedBy) {
      return json({ success: false, message: 'Another application operation is already running.' }, { status: 409 });
    }
    if (!respondAsync) return finish({ success: false, message: error.message, statusCode: 409 }, error.task.id);
    return json({ error: error.message, operation: operationView(error.task) }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
}
