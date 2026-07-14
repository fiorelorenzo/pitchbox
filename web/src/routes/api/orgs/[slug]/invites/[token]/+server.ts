import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { findOrgBySlug, isOrgAdmin, revokeInvite } from '@pitchbox/shared/orgs';

// Revoke a pending invite. Admin-only; 404s (rather than 403) when the org is
// missing or the caller isn't an admin, to avoid leaking org existence.
export async function DELETE(event: import('@sveltejs/kit').RequestEvent) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const slug = event.params.slug as string;
  const token = event.params.token as string;
  const db = getDb();
  const org = await findOrgBySlug(db, slug);
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  if (!(await isOrgAdmin(db, user.id, org.id))) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  const removed = await revokeInvite(db, org.id, token);
  if (!removed) return json({ error: 'not_found' }, { status: 404 });
  return json({ ok: true });
}
