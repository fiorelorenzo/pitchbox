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
      chatRoomId: schema.contactHistory.chatRoomId,
      platformContextUrl: schema.contactHistory.platformContextUrl,
      draftKind: schema.drafts.kind,
    })
    .from(schema.messages)
    .innerJoin(schema.contactHistory, eq(schema.messages.contactId, schema.contactHistory.id))
    .leftJoin(schema.drafts, eq(schema.contactHistory.draftId, schema.drafts.id))
    .where(and(eq(schema.contactHistory.draftId, id), eq(schema.messages.isFromUs, false)))
    .orderBy(desc(schema.messages.createdAtPlatform))
    .limit(1);
  return json(msg ?? null);
};
