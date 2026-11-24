import { db, safeWorkerColumns } from '#lib/db/index.ts';
import { workers } from '#lib/db/schema.ts';
import { requirePageAdmin } from '#lib/server/auth.ts';

export const load = async (event: { locals: App.Locals }) => {
  const currentUser = requirePageAdmin(event).user;

  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();

  return {
    user: currentUser,
    workers: allWorkers,
  };
};
