import { error } from '@sveltejs/kit';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';
import { getDb, schema } from './db.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Issue #185: every device token (auto-pair, pairing-code redemption, rotate)
// carries a 90-day TTL from the moment it's minted.
export const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Mint a fresh device bearer token plus its 90-day expiry. Shared by every
 * path that mints or renews a device row so the TTL and hashing stay
 * consistent (auto-pair, the pairing-code redemption endpoint, and rotate).
 */
export function mintDeviceToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + DEVICE_TOKEN_TTL_MS),
  };
}

export type ExtensionAuthContext = {
  deviceId: number;
  /**
   * The organization the device is bound to, or null for a device paired on a
   * self-hosted / auth-off install where no org resolved. Routes that touch
   * tenant data must scope by this when it is non-null; a null org keeps full
   * access, mirroring `requireRole`'s no-op when auth is off.
   */
  organizationId: number | null;
};

export async function requireExtensionAuth(request: Request): Promise<ExtensionAuthContext> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) throw error(401, 'missing bearer token');
  const token = match[1];

  const db = getDb();
  const tokenHash = hashToken(token);
  const [device] = await db
    .select()
    .from(schema.extensionDevices)
    .where(
      and(
        eq(schema.extensionDevices.tokenHash, tokenHash),
        isNull(schema.extensionDevices.revokedAt),
        // #185: a device with no expiresAt is valid forever; one with an
        // expiresAt in the past is treated identically to an unknown token
        // (generic "invalid token" message - don't leak why it failed).
        or(
          isNull(schema.extensionDevices.expiresAt),
          gt(schema.extensionDevices.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  if (!device) throw error(401, 'invalid token');

  await db
    .update(schema.extensionDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.extensionDevices.id, device.id));
  return { deviceId: device.id, organizationId: device.organizationId };
}

/**
 * Guard a draft-scoped extension route against cross-tenant access: when the
 * device is bound to an org, the draft must belong to it, otherwise we 404
 * (the same "not found" the route gives for a truly missing draft, so it
 * leaks nothing about other tenants' ids). A null-org device (self-host /
 * auth-off) is unrestricted.
 */
export async function assertDraftInDeviceOrg(
  db: ReturnType<typeof getDb>,
  draftId: number,
  auth: ExtensionAuthContext,
): Promise<void> {
  if (auth.organizationId == null) return;
  const ok = await draftBelongsToOrg(db, draftId, auth.organizationId);
  if (!ok) throw error(404, 'draft not found');
}
