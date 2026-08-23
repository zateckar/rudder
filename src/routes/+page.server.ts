import { redirect } from '@sveltejs/kit';
import { requirePageUser } from '$lib/server/auth';

/** `/` is a signpost: signed in goes to the dashboard, otherwise to the login. */
export const load = async (event: { locals: App.Locals }) => {
  requirePageUser(event);
  throw redirect(303, '/dashboard');
};
