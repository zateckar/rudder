import { redirect } from '@sveltejs/kit';
import { currentUser, userTeams } from '$lib/server/auth';

/**
 * The user every page's layout renders, and the gate that sends an anonymous
 * caller to the login form.
 *
 * Reads `locals.auth`, which `hooks.server.ts` has already resolved — this used
 * to validate the session and read the `users` row itself, which was the second
 * of the three times a single page load did both.
 */
export const load = async (event: { locals: App.Locals; url: URL }) => {
  const ctx = currentUser(event);

  // Public paths that must not redirect to /login.
  const isPublicPath =
    event.url.pathname === '/login' || event.url.pathname.startsWith('/api/health');

  if (!ctx) {
    if (!isPublicPath) throw redirect(303, '/login');
    return { user: null, teams: [] };
  }

  // Loaded here rather than fetched from `/api/teams` by the sidebar's own
  // `$effect`. That fetch was a second authenticated round trip after *every*
  // navigation, and the sidebar rendered without its team selector until it
  // came back — a visible flash on every page.
  //
  // `AuthContext.user` is already the safe column subset — no password hash, by
  // construction rather than by remembering to exclude it.
  return {
    user: ctx.user,
    teams: (await userTeams(event)).map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
  };
};
