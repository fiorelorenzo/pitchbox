import { json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { countOrgOwners, findOrgBySlug, getMemberRole, removeMember } from '@pitchbox/shared/orgs';

// Leave the org (self-remove). The sole owner cannot leave (it would orphan the
// org); they must transfer ownership or delete the org first.
export async function POST(event: RequestEvent) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const db = getDb();
  const org = await findOrgBySlug(db, event.params.slug as string);
  if (!org) return json({ error: 'not_found' }, { status: 404 });
  const role = await getMemberRole(db, org.id, user.id);
  if (!role) return json({ error: 'not_found' }, { status: 404 });
  if (role === 'owner' && (await countOrgOwners(db, org.id)) <= 1) {
    return json(
      { error: 'You are the only owner. Transfer ownership or delete the organization first.' },
      { status: 400 },
    );
  }
  await removeMember(db, org.id, user.id);
  return json({ ok: true });
}
