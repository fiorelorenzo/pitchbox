import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

const Body = z.object({
  code: z
    .string()
    .min(4)
    .max(64)
    .regex(/^[A-Z0-9-]+$/i),
  label: z.string().max(120).optional(),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Public endpoint - no auth required. The pairing code itself is the
// short-lived secret. Each code can be consumed exactly once.
export async function POST({ request }: { request: Request }) {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  const code = parsed.data.code.trim().toUpperCase();

  // Atomically claim the code: the UPDATE only returns a row when it flips
  // consumed_at from null to now while the code is still unexpired, so two
  // concurrent redemptions of the same code can never both succeed - the loser
  // matches zero rows and gets nothing back, instead of racing a separate
  // select-then-update where both callers could pass the select (#179).
  const [pairing] = await db
    .update(schema.extensionPairings)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.extensionPairings.code, code),
        isNull(schema.extensionPairings.consumedAt),
        gt(schema.extensionPairings.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!pairing) throw error(404, 'invalid_or_expired_code');

  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await db.insert(schema.extensionDevices).values({
    organizationId: pairing.organizationId,
    label: parsed.data.label ?? 'Chrome extension',
    tokenHash,
  });

  return json({ token });
}
