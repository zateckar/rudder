import { requirePageAdmin } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  return { user: requirePageAdmin(event).user };
};
