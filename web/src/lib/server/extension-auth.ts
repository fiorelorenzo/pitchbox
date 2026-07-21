import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';
import { getDb, schema } from './db.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
