import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events.js';
import { evaluateDraftSend } from '@pitchbox/shared/draft-send';

const ALLOWED = ['approved', 'rejected', 'sent'] as const;
type AllowedState = (typeof ALLOWED)[number];

type PatchBody = { state?: string; sentContent?: string };

export async function PATCH({ params, request }: { params: { id: string }; request: Request }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');

  const body = (await request.json()) as PatchBody;
  if (!body.state || !ALLOWED.includes(body.state as AllowedState)) {
    throw error(400, 'invalid state');
  }
  const newState = body.state as AllowedState;

  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');

  const now = new Date();

  if (newState === 'sent') {
    const evald = await evaluateDraftSend(db, draft, now);
    if (evald.kind === 'blocked') {
      throw error(409, `blocklisted: ${evald.reason ?? 'no reason'}`);
    }

    const edited = typeof body.sentContent === 'string' && body.sentContent.trim().length > 0;
    const sentContent = edited ? body.sentContent! : draft.body;

    await db
      .update(schema.drafts)
      .set({
        state: newState,
        reviewedAt: draft.reviewedAt ?? now,
        sentAt: now,
        sentContent,
      })
      .where(eq(schema.drafts.id, id));

    const details: Record<string, unknown> = {
      ...(edited && sentContent !== draft.body ? { edited: true } : {}),
      ...(evald.quotaEventDetails ?? {}),
    };

    await db.insert(schema.draftEvents).values({
      draftId: id,
      event: 'sent',
      actor: 'user',
      details,
    });

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, draft.accountId));
    if (account && draft.targetUser) {
      await db.insert(schema.contactHistory).values({
        platformId: draft.platformId,
        accountHandle: account.handle,
        targetUser: draft.targetUser,
        lastContactedAt: now,
        draftId: id,
      });
    }
  } else {
    await db
      .update(schema.drafts)
      .set({ state: newState, reviewedAt: draft.reviewedAt ?? now })
      .where(eq(schema.drafts.id, id));
    await db.insert(schema.draftEvents).values({
      draftId: id,
      event: newState,
      actor: 'user',
      details: {},
    });
  }

  emit('drafts:changed', { id, state: newState });
  return json({ ok: true });
}
