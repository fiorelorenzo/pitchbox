import { json, error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth, mintDeviceToken, hashToken } from '$lib/server/extension-auth.js';

/**
 * Rotate the calling device's bearer token (#185).
 *
 * Mints a fresh token + a new 90-day expiry for the SAME device row: the old
 * token hash is overwritten in place, so it stops authenticating immediately
 * (there is no grace-period overlap). Called opportunistically by the
 * extension when its stored token is unset or close to expiry - see
 * `extension/src/lib/api.ts`'s `handshake`/`rotate`.
 */
export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  // The exact hash of the token this request authenticated with, for the
  // compare-and-swap below.
  const presentedToken = /^Bearer\s+(.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  const oldHash = hashToken(presentedToken ?? '');
  const db = getDb();

  const { token, tokenHash, expiresAt } = mintDeviceToken();
  // CAS on the presented token: only the FIRST of two concurrent rotates that
  // share the same old token flips the hash; a second concurrent call matches
  // zero rows (the hash already moved) and is told so (409) instead of blindly
  // overwriting with a token the caller then fails to persist. Without this a
  // double-rotate (e.g. two side-panel windows near expiry) could lose an
  // update and permanently brick the pairing.
  const rotated = await db
    .update(schema.extensionDevices)
    .set({ tokenHash, expiresAt })
    .where(
      and(
        eq(schema.extensionDevices.id, auth.deviceId),
        eq(schema.extensionDevices.tokenHash, oldHash),
      ),
    )
    .returning({ id: schema.extensionDevices.id });
  if (rotated.length === 0) throw error(409, 'rotate_conflict');

  return json({ token, expiresAt: expiresAt.toISOString() });
}
