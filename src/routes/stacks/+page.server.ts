import { requirePageUser, userTeams } from '$lib/server/auth';

export const load = async (event: { locals: App.Locals }) => {
  const user = requirePageUser(event).user;
  return { user, teams: await userTeams(event) };
};
