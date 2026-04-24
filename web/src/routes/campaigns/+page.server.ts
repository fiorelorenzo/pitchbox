import { getDb, schema } from '$lib/server/db.js';
import { desc } from 'drizzle-orm';

export async function load() {
  const db = getDb();
  const campaigns = await db.select().from(schema.campaigns);
  const recentRuns = await db
    .select()
    .from(schema.runs)
    .orderBy(desc(schema.runs.startedAt))
    .limit(20);
  return { campaigns, recentRuns };
}
