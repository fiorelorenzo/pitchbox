import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Self-service language override (LOR-262), same gate as
 * /settings/password: signed in is the whole requirement, no org role.
 * `locals.user` missing here means auth is off - there is no account to
 * hold a preference for, so 404 rather than a picker that writes nowhere.
 *
 * No DB read of its own: the effective locale to preselect is
 * `event.locals.locale` (already resolved, LOR-260/262), inherited from the
 * root `+layout.server.ts` load into this page's merged `data` - showing
 * "whatever this request is actually rendering in" is the honest default,
 * whether that came from the stored preference or a fallback.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw error(404, 'not_found');
  return {};
};
