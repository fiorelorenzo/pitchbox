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

// Public endpoint — no auth required. The pairing code itself is the
// short-lived secret. Each code can be consumed exactly once.
export async function POST({ request }: { request: Request }) {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  const code = parsed.data.code.trim().toUpperCase();
  const [pairing] = await db
    .select()
    .from(schema.extensionPairings)
    .where(
      and(
        eq(schema.extensionPairings.code, code),
        isNull(schema.extensionPairings.consumedAt),
        gt(schema.extensionPairings.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!pairing) throw error(404, 'invalid_or_expired_code');

  // Consume the code, then issue a long-lived device token.
  const now = new Date();
  await db
    .update(schema.extensionPairings)
    .set({ consumedAt: now })
    .where(eq(schema.extensionPairings.code, code));

  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await db.insert(schema.extensionDevices).values({
    organizationId: pairing.organizationId,
    label: parsed.data.label ?? 'Chrome extension',
    tokenHash,
  });

  return json({ token });
}
