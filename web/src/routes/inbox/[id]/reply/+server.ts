import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const db = getDb();
  const [msg] = await db
    .select({
      body: schema.messages.body,
      author: schema.messages.author,
      createdAt: schema.messages.createdAtPlatform,
    })
    .from(schema.messages)
    .innerJoin(
      schema.contactHistory,
      eq(schema.messages.contactId, schema.contactHistory.id),
    )
    .where(
      and(
        eq(schema.contactHistory.draftId, id),
        eq(schema.messages.isFromUs, false),
      ),
    )
    .orderBy(desc(schema.messages.createdAtPlatform))
    .limit(1);
  return json(msg ?? null);
};
