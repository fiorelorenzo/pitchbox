import { json, error } from '@sveltejs/kit';
import { getDb } from '../../../../lib/server/db.js';
import { setSessionActiveOrg } from '@pitchbox/shared/auth';
import { loadActiveOrganization } from '@pitchbox/shared/orgs';

const SESSION_COOKIE = 'pitchbox_session';

export async function POST(event: import('@sveltejs/kit').RequestEvent) {
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');
  const body = (await event.request.json()) as { organizationId?: number };
  if (!body.organizationId) throw error(400, 'organizationId required');

  const db = getDb();
  const org = await loadActiveOrganization(db, user.id, body.organizationId);
  if (!org || org.id !== body.organizationId) throw error(403, 'forbidden');

  const cookie = event.cookies.get(SESSION_COOKIE);
  if (cookie) await setSessionActiveOrg(db, cookie, org.id);
  return json({ org });
}
