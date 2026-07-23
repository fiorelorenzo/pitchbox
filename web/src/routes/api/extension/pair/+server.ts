import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { mintDeviceToken } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';

const Body = z.object({
  code: z
    .string()
    .min(4)
    .max(64)
    .regex(/^[A-Z0-9-]+$/i),
  label: z.string().max(120).optional(),
});

// #194: per-IP throttle on this public, token-minting endpoint. In-memory and
// process-local (prod web is a single container - see rate-limit.ts). Keyed on
// getClientAddress(), which only reflects the real client because the prod
// overlay sets ADDRESS_HEADER=x-forwarded-for + XFF_DEPTH=1 (Caddy is the one
// trusted proxy); without that it would collapse to a single global bucket an
// attacker could trip to 429-lock onboarding for everyone.
const pairAttemptLimiter = new RateLimiter(20, 60_000);

// Public endpoint - no auth required. The pairing code itself is the
// short-lived secret. Each code can be consumed exactly once.
export async function POST({ request, getClientAddress }: RequestEvent) {
  // Throttle BEFORE any await so the check-and-increment is atomic per request:
  // a concurrent burst from one IP can't all slip past a separate
  // check-then-record.
  const ip = getClientAddress?.() ?? 'unknown';
  if (!pairAttemptLimiter.consume(ip)) throw error(429, 'too_many_attempts');

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  const code = parsed.data.code.trim().toUpperCase();

  // #179: atomically claim the code - the UPDATE only returns a row when it
  // flips consumed_at from null to now while the code is still unexpired, so
  // two concurrent redemptions of the same code can never both succeed.
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
  if (pairing.organizationId == null) throw error(500, 'no_org');

  // #200: surface which org/device the pairing belongs to, not just a token.
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, pairing.organizationId))
    .limit(1);

  // #185: mint the device token with a 90-day TTL (shared minting helper).
  const { token, tokenHash, expiresAt } = mintDeviceToken();
  const deviceLabel = parsed.data.label ?? 'Chrome extension';
  await db.insert(schema.extensionDevices).values({
    organizationId: pairing.organizationId,
    label: deviceLabel,
    tokenHash,
    expiresAt,
  });

  return json({ token, orgName: org?.name ?? null, deviceLabel });
}
