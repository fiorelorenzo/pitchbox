import type { LayoutServerLoad } from './$types';
import { requireInstanceAdmin } from '$lib/server/auth.js';

// Instance admin area (#412). This gates the whole subtree from one place
// rather than every `+page.server.ts` under it repeating the same call: a
// layout `load` runs for every route it wraps, including ones added later
// (#411's model configuration page lands as a sibling under here), so a new
// page gets the real gate for free without touching this file. That's a
// deliberate departure from the rest of settings/ (each of those routes
// gates itself in its own loader, see docs/permissions.md) - this area is
// small, single-purpose, and has a second author queued up behind it, so the
// single point of enforcement matters more here than matching the sibling
// convention does. Unlike `requireRole`, `requireInstanceAdmin` gates on the
// signed-in user's `is_instance_admin` column, not the active-org role, so
// an org owner who isn't the instance admin still 403s. A no-op when auth is
// off (no `locals.user`), same convention as the rest of settings.
export const load: LayoutServerLoad = async (event) => {
  await requireInstanceAdmin(event);
  return {};
};
