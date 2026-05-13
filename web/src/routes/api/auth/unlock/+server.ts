import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '../../../../lib/server/db.js';
import { clearAuthFailures, loadSession } from '@pitchbox/shared/auth';

const COOKIE = 'pitchbox_session';

async function requireSession(event: RequestEvent): Promise<void> {
  if (process.env.PITCHBOX_AUTH !== 'on') return;
  const token = event.cookies.get(COOKIE);
  const session = token ? await loadSession(getDb(), token) : null;
  if (!session) throw error(401, 'unauthenticated');
}

const Body = z.object({
  username: z.string().min(1).max(64),
  // Optional: also clear the IP bucket if provided.
  ip: z.string().min(1).max(128).optional(),
});

// Clears the rolling failure counter for a username (and optionally an IP) so
// a locked-out account can sign in again without waiting out the window.
export async function POST(event: RequestEvent) {
  await requireSession(event);
  const { request } = event;
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();
  const cleared = await clearAuthFailures(db, `user:${parsed.data.username}`);
  let ipCleared = 0;
  if (parsed.data.ip) {
    ipCleared = await clearAuthFailures(db, `ip:${parsed.data.ip}`);
  }
  return json({ ok: true, cleared, ipCleared });
}
