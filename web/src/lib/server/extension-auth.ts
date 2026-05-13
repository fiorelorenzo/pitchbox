import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { verifyExtensionToken } from '@pitchbox/shared/extension-token';
import { getDb, schema } from './db.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ExtensionAuthContext = { deviceId: number | null };

export async function requireExtensionAuth(request: Request): Promise<ExtensionAuthContext> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) throw error(401, 'missing bearer token');
  const token = match[1];

  // 1) Try per-device token (new model).
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
  if (device) {
    await db
      .update(schema.extensionDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.extensionDevices.id, device.id));
    return { deviceId: device.id };
  }

  // 2) Fall back to the legacy shared token in app_config.
  const ok = await verifyExtensionToken(token);
  if (!ok) throw error(401, 'invalid token');
  return { deviceId: null };
}
