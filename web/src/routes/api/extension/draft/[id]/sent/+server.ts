import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';

type SentBody = { sentContent?: string; sentAt?: string };

export async function POST({
  params,
  request,
}: {
  params: { id: string };
  request: Request;
}) {
  await requireExtensionAuth(request);
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw error(400, 'invalid id');
  const body = (await request.json().catch(() => ({}))) as SentBody;

  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');
  if (draft.state === 'sent') {
    return json({ ok: true, alreadySent: true });
  }

  const now = body.sentAt ? new Date(body.sentAt) : new Date();
  const edited = typeof body.sentContent === 'string' && body.sentContent.trim().length > 0;
  const sentContent = edited ? body.sentContent! : draft.body;

  await db
    .update(schema.drafts)
    .set({
      state: 'sent',
      reviewedAt: draft.reviewedAt ?? now,
      sentAt: now,
      sentContent,
    })
    .where(eq(schema.drafts.id, id));

  await db.insert(schema.draftEvents).values({
    draftId: id,
    event: 'sent',
    actor: 'extension',
    details: edited && sentContent !== draft.body ? { edited: true } : {},
  });

  if (draft.kind === 'dm' && draft.targetUser) {
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, draft.accountId));
    if (account) {
      await db.insert(schema.contactHistory).values({
        platformId: draft.platformId,
        accountHandle: account.handle,
        targetUser: draft.targetUser,
        lastContactedAt: now,
        draftId: id,
      });
    }
  }

  emit('drafts:changed', { id, state: 'sent' });
  return json({ ok: true });
}
