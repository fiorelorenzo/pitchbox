import { getDb, schema } from '@pitchbox/shared/db';
import { asc } from 'drizzle-orm';

export async function load() {
  const db = getDb();
  const campaigns = await db
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaigns)
    .orderBy(asc(schema.campaigns.name));
  return { campaigns };
}
