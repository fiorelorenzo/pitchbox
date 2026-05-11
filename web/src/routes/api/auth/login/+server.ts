import { json, error, type Cookies } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import {
  countUsers,
  createSession,
  createUser,
  findUserByUsername,
  verifyPassword,
} from '@pitchbox/shared/auth';

const Body = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(256),
});

const COOKIE = 'pitchbox_session';

export async function POST({ request, cookies }: { request: Request; cookies: Cookies }) {
  if (process.env.PITCHBOX_AUTH !== 'on') {
    throw error(404, 'auth_disabled');
  }
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();

  let userId: number;
  const total = await countUsers(db);
  if (total === 0) {
    // First user becomes the admin on first login attempt.
    userId = await createUser(db, parsed.data.username, parsed.data.password);
  } else {
    const user = await findUserByUsername(db, parsed.data.username);
    if (!user) throw error(401, 'invalid_credentials');
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) throw error(401, 'invalid_credentials');
    userId = user.id;
  }

  const session = await createSession(db, userId);
  cookies.set(COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: session.expiresAt,
  });
  return json({ ok: true });
}
