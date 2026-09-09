import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Self-service password change. Gated on having a signed-in user rather than
 * an org role (docs/permissions.md) - a password change needs nothing beyond
 * being the account holder. hooks.server.ts already requires a valid session
 * for this route when auth is on (#132's exempt list only covers /login and
 * /api/auth/{login,logout}), so `locals.user` missing here means auth is
 * off - there's no login concept and nothing to change a password for, so
 * 404 rather than a misleading empty form.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw error(404, 'not_found');
  return { username: event.locals.user.username };
};
