import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq, asc } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const db = getDb();
  const events = await db
    .select()
    .from(schema.draftEvents)
    .where(eq(schema.draftEvents.draftId, id))
    .orderBy(asc(schema.draftEvents.createdAt));
  return json(events);
};
