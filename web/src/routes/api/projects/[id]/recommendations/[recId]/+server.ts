import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

function parseId(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function DELETE({ params }) {
  const id = parseId(params.id);
  const recId = parseId(params.recId);
  if (!id || !recId) return json({ error: 'invalid_id' }, { status: 400 });
  const db = getDb();
  const result = await db
    .delete(schema.campaignRecommendations)
    .where(
      and(
        eq(schema.campaignRecommendations.id, recId),
        eq(schema.campaignRecommendations.projectId, id),
      ),
    )
    .returning({ id: schema.campaignRecommendations.id });
  if (result.length === 0) return json({ error: 'not_found' }, { status: 404 });
  return json({ ok: true });
}
