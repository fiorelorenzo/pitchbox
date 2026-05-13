import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { acceptInvite } from '@pitchbox/shared/orgs';

export async function POST(event) {
  const user = event.locals.user;
  if (!user) return json({ error: 'unauthenticated' }, { status: 401 });
  const token = event.params.token as string;
  const db = getDb();
  const result = await acceptInvite(db, token, user.id);
  if (!result) return json({ error: 'invite_invalid' }, { status: 404 });
  return json({ organizationId: result.organizationId, role: result.role });
}
