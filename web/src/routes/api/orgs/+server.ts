import { json, error } from '@sveltejs/kit';
import { getDb } from '../../../lib/server/db.js';
import { createOrganization } from '@pitchbox/shared/orgs';
import { setSessionActiveOrg } from '@pitchbox/shared/auth';

const SESSION_COOKIE = 'pitchbox_session';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export async function POST(event: import('@sveltejs/kit').RequestEvent) {
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');
  const body = (await event.request.json()) as { slug?: string; name?: string };
  const slug = (body.slug ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim();
  if (!SLUG_RE.test(slug)) throw error(400, 'invalid slug');
  if (!name) throw error(400, 'name required');

  const db = getDb();
  try {
    const org = await createOrganization(db, { slug, name, ownerUserId: user.id });
    const cookie = event.cookies.get(SESSION_COOKIE);
    if (cookie) await setSessionActiveOrg(db, cookie, org.id);
    return json({ org }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    const code = e?.code ?? e?.cause?.code;
    if (code === '23505') throw error(409, 'slug taken');
    throw err;
  }
}
