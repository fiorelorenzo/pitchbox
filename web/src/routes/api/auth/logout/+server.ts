import { json, type Cookies } from '@sveltejs/kit';
import { getDb } from '../../../../lib/server/db.js';
import { deleteSession } from '@pitchbox/shared/auth';

const COOKIE = 'pitchbox_session';

export async function POST({ cookies }: { cookies: Cookies }) {
  const token = cookies.get(COOKIE);
  if (token) {
    await deleteSession(getDb(), token);
  }
  cookies.delete(COOKIE, { path: '/' });
  return json({ ok: true });
}
