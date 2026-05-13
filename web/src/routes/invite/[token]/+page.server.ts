import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { acceptInvite, findValidInvite } from '@pitchbox/shared/orgs';

export const load = async (event) => {
  const token = event.params.token as string;
  const db = getDb();
  const invite = await findValidInvite(db, token);
  if (!invite) {
    return { ok: false, reason: 'invalid_or_expired' as const };
  }
  if (!event.locals.user) {
    const next = encodeURIComponent(event.url.pathname);
    throw redirect(302, `/login?next=${next}`);
  }
  const accepted = await acceptInvite(db, token, event.locals.user.id);
  if (!accepted) {
    return { ok: false, reason: 'invalid_or_expired' as const };
  }
  throw redirect(302, '/');
};
