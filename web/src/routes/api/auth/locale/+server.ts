import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { setUserLocale } from '@pitchbox/shared/auth';

const Body = z.object({ locale: z.enum(['en', 'it']) });

/**
 * Self-service language override (LOR-262). Same self-service posture as
 * /api/auth/password - gated on being signed in, nothing more - and it is
 * the one place that writes `users.locale`, shared with the extension's
 * device-token-authenticated POST /api/extension/locale
 * (`shared/src/auth.ts`'s `setUserLocale`), so the two write paths cannot
 * drift on what "set" means.
 *
 * A user in more than one organization, or a second organization entirely,
 * is unaffected either way: this column lives on `users`, not on
 * `memberships` or `organizations`, so it is one value per person
 * regardless of which org their session is currently active in.
 */
export async function POST(event: RequestEvent) {
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');

  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  await setUserLocale(getDb(), user.id, parsed.data.locale);
  return json({ ok: true, locale: parsed.data.locale });
}
