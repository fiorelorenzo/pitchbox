import { json } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

const TTL_MS = 10 * 60 * 1000;

function generateCode(): string {
  // Group of 4 + 4 hex chars, easy to read aloud / paste.
  const raw = randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export async function POST() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'));
  const code = generateCode();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(schema.extensionPairings).values({
    code,
    organizationId: org?.id ?? null,
    expiresAt,
  });
  return json({ code, expiresAt });
}
