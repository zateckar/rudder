import { requirePageUser } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  return { user: requirePageUser(event).user };
};
