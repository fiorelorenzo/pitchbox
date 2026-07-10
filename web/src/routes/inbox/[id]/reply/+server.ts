import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
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
}
