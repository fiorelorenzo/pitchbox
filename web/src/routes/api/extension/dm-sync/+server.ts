import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { matchIncomingDms, type ContactRow, type IncomingDm } from '@pitchbox/shared/dm-sync';

type Body = { platform: string; items: IncomingDm[] };

export async function POST({ request }: { request: Request }) {
  await requireExtensionAuth(request);
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || !Array.isArray(body.items) || typeof body.platform !== 'string') {
    throw error(400, 'invalid body');
  }
  if (body.items.length === 0) return json({ ok: true, inserted: 0, replied: 0 });

  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platform));
  if (!platform) throw error(404, 'unknown platform');

  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({
      id: schema.contactHistory.id,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      platformId: schema.contactHistory.platformId,
      draftId: schema.contactHistory.draftId,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
    })
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.platformId, platform.id));

  const fresh: ContactRow[] = candidates
    .filter((c) => c.lastContactedAt >= since)
    .map((c) => ({
      id: c.id,
      accountHandle: c.accountHandle,
      targetUser: c.targetUser,
      platformId: c.platformId,
      draftId: c.draftId,
      lastContactedAt: c.lastContactedAt,
      repliedAt: c.repliedAt,
    }));

  const { inserts, updates } = matchIncomingDms(body.items, fresh);
  if (inserts.length === 0) return json({ ok: true, inserted: 0, replied: 0 });

  await db.transaction(async (tx) => {
    for (const row of inserts) {
      await tx
        .insert(schema.messages)
        .values(row)
        .onConflictDoNothing({
          target: [schema.messages.platformId, schema.messages.platformMessageId],
        });
    }
    for (const u of updates) {
      await tx
        .update(schema.contactHistory)
        .set({ repliedAt: u.repliedAt, replyCheckedAt: new Date() })
        .where(eq(schema.contactHistory.id, u.contactId));
      if (u.draftId != null) {
        await tx.insert(schema.draftEvents).values({
          draftId: u.draftId,
          event: 'replied',
          actor: 'extension',
          details: { at: u.repliedAt.toISOString() },
        });
      }
    }
  });

  const nowIso = new Date().toISOString();
  await db
    .insert(schema.appConfig)
    .values({ key: 'extension_last_dm_sync_at', value: nowIso })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { value: nowIso },
    });

  for (const u of updates) {
    if (u.draftId != null) emit('drafts:changed', { id: u.draftId, state: 'replied' });
  }

  return json({ ok: true, inserted: inserts.length, replied: updates.length });
}
