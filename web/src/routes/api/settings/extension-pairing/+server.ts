import { json, error, type RequestEvent } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { getDb, schema } from '$lib/server/db.js';
import { resolveOrgId, requireRole } from '$lib/server/auth.js';

const TTL_MS = 10 * 60 * 1000;

function generateCode(): string {
  // Group of 4 + 4 hex chars, easy to read aloud / paste.
  const raw = randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export async function POST(event: RequestEvent) {
  requireRole(event, 'admin');
  const db = getDb();
  // Attribute the pairing to the caller's active org (falls back to the
  // default org when auth is off / no membership exists yet), not always the
  // hardcoded default org.
  const organizationId = await resolveOrgId(event);
  // #196: fail loudly instead of minting an orphaned (null-org) pairing code
  // that a later /api/extension/pair redemption could turn into an orphaned
  // device - no row is inserted below this point.
  if (organizationId == null) throw error(409, 'no_org');
  const code = generateCode();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(schema.extensionPairings).values({
    code,
    organizationId,
    expiresAt,
  });
  return json({ code, expiresAt });
}
