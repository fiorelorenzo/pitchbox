import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { setUserLocale } from '@pitchbox/shared/auth';

// LOR-262: the write half of the account-wide language override. The
// extension's Settings tab picker (LanguageCard.svelte) already persists to
// its own `chrome.storage.local` the moment the user picks a language; this
// route is what makes that write-through to the account rather than staying
// local-only, so a dashboard reload afterward agrees with it. Device-token
// authenticated, matching every other write on this plane (dm-sync,
// operator-profile, voice-import) rather than a session cookie - the
// extension has no session, only its paired bearer token.
//
// `synced: false` (still a 200, not an error) is the expected outcome for a
// device with no bound user - a self-hosted / auth-off install, or a
// device paired by redeeming a one-time code rather than through the
// session-carrying auto-pair flow (see extension-auth.ts's
// `ExtensionAuthContext.userId` doc comment). There is no account to write
// through to in that case; the extension's own local `chrome.storage`
// write already happened and stays the source of truth for that device.
const Body = z.object({ locale: z.enum(['en', 'it']) });

const perDevice = new RateLimiter(20, 60_000);

export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many requests');

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  if (auth.userId == null) {
    return json({ synced: false, locale: null });
  }

  const db = getDb();
  await setUserLocale(db, auth.userId, parsed.data.locale);
  return json({ synced: true, locale: parsed.data.locale });
}
