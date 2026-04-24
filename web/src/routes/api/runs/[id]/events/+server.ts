import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { asc, eq } from 'drizzle-orm';

export async function GET({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const db = getDb();
  const events = await db
    .select({
      id: schema.runEvents.id,
      seq: schema.runEvents.seq,
      kind: schema.runEvents.kind,
      payload: schema.runEvents.payload,
      ts: schema.runEvents.createdAt,
    })
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, id))
    .orderBy(asc(schema.runEvents.seq), asc(schema.runEvents.id))
    .limit(5000);
  return json({ runId: id, events });
}
