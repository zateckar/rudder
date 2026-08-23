import { db, safeWorkerColumns } from '$lib/db';
import { workers } from '$lib/db/schema';
import { requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  const currentUser = requirePageAdmin(event).user;

  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();

  return {
    user: currentUser,
    workers: allWorkers,
  };
};
