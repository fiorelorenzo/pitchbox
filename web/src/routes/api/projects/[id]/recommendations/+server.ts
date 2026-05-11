import { json } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET({ params }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.campaignRecommendations)
    .where(eq(schema.campaignRecommendations.projectId, id))
    .orderBy(desc(schema.campaignRecommendations.createdAt));
  return json({ recommendations: rows });
}
