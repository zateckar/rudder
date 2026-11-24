import { requirePageAdmin } from '#lib/server/auth.ts';

export const load = async (event: { locals: App.Locals }) => {
  return { user: requirePageAdmin(event).user };
};
