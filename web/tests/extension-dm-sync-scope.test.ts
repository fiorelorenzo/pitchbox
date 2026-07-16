import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as dmSyncPost } from '../src/routes/api/extension/dm-sync/+server.js';

// Issue #120: the newest-inbound-message lookup inside dm-sync used to select
// EVERY message row for the platform, then filter/sort in JS, on every sync
// tick. This test drives the real route end to end and inspects the SQL sent
// to Postgres to confirm the lookup is now bounded to the draft ids touched
// by this sync call, not the whole platform's message history.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'scope-test', name: 'scope-test' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId: platform.id, handle: 'us_handle' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'c',
      skillSlug: 'reddit-scout',
    })
    .returning();
  // agentRunner is a made-up slug on purpose: it makes the fire-and-forget
  // reply-drafting dispatch that dm-sync kicks off fail fast inside
  // createAgentRunner ("Unknown agent runner") instead of spawning a real
  // agent process, so the test stays hermetic.
  const [origin] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      trigger: 'manual',
      status: 'success',
      agentRunner: 'test-noop',
    })
    .returning();

  // The target draft: this is the one dm-sync should flip to `replied` in
  // this call, and whose newest inbound message we must find.
  const [targetDraft] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hi there',
      targetUser: 'target_user',
      state: 'sent',
      sentAt: new Date(),
    })
    .returning();
  const [targetContact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: 'us_handle',
      targetUser: 'target_user',
      lastContactedAt: new Date(Date.now() - 60 * 60 * 1000),
      draftId: targetDraft.id,
      repliedAt: null,
    })
    .returning();

  // An unrelated draft NOT touched by this sync call, with its own contact
  // and a pile of pre-existing inbound messages. Before the fix, the
  // newest-message lookup scanned all of these too.
  const [noiseDraft] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hi noise',
      targetUser: 'noise_user',
      state: 'sent',
      sentAt: new Date(),
    })
    .returning();
  const [noiseContact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: 'us_handle',
      targetUser: 'noise_user',
      lastContactedAt: new Date(Date.now() - 60 * 60 * 1000),
      draftId: noiseDraft.id,
      repliedAt: new Date(Date.now() - 30 * 60 * 1000),
    })
    .returning();

  const noiseRows = Array.from({ length: 20 }, (_, i) => ({
    contactId: noiseContact.id,
    draftId: noiseDraft.id,
    platformId: platform.id,
    author: 'noise_user',
    isFromUs: false,
    body: `noise message ${i}`,
    platformMessageId: `noise-${i}`,
    createdAtPlatform: new Date(),
    source: 'extension' as const,
  }));
  await db.insert(schema.messages).values(noiseRows);

  const token = randomBytes(32).toString('hex');
  await db.insert(schema.extensionDevices).values({
    label: 'scope-test device',
    tokenHash: hashToken(token),
  });

  return { targetDraft, targetContact, noiseDraft, token };
}

function syncRequest(token: string, body: unknown): Request {
  return new Request('http://localhost/api/extension/dm-sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/extension/dm-sync newest-message scoping', () => {
  beforeEach(reset);

  it('bounds the newest-message lookup to the just-updated draft ids and ignores unrelated drafts', async () => {
    const { targetDraft, noiseDraft, token } = await seed();

    const pool = getPool();
    const originalQuery = pool.query.bind(pool);
    const calls: { text: string; params: unknown[] }[] = [];
    (pool as any).query = (...args: any[]) => {
      const [arg0, arg1] = args;
      const text = typeof arg0 === 'string' ? arg0 : (arg0?.text ?? '');
      const params = Array.isArray(arg1) ? arg1 : (arg0?.values ?? []);
      calls.push({ text, params });
      return originalQuery(...(args as Parameters<typeof originalQuery>));
    };

    try {
      const res = await dmSyncPost({
        request: syncRequest(token, {
          platform: 'reddit',
          items: [
            {
              fromUser: 'target_user',
              toUser: 'us_handle',
              body: 'a real reply',
              threadId: 'real-1',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      } as unknown as Parameters<typeof dmSyncPost>[0]);

      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean; inserted: number; replied: number };
      expect(payload.inserted).toBe(1);
      expect(payload.replied).toBe(1);

      // Find the newest-message lookup query: it selects id/draftId/
      // platformMessageId/platformId/isFromUs from "messages".
      const lookupCall = calls.find(
        (c) =>
          c.text.includes('from "messages"') &&
          c.text.includes('"is_from_us"') &&
          c.text.includes('"platform_message_id"'),
      );
      expect(lookupCall).toBeDefined();

      // The query must be bounded by draft_id, not just platform_id - this
      // is the acceptance criterion for issue #120.
      expect(lookupCall!.text).toMatch(/"messages"\."draft_id"\s+(in|=\s*any)/i);

      // The noise draft's id must never be sent as a scoping parameter -
      // only the target draft (the one just flipped to `replied`) should be.
      expect(lookupCall!.params).toContain(targetDraft.id);
      expect(lookupCall!.params).not.toContain(noiseDraft.id);

      // Behavior must be unchanged: the reply-drafting trigger picked the
      // real synced message (not a noise row) as the newest inbound message
      // for the target draft, so it enqueued exactly one placeholder reply.
      const replyDrafts = await getDb()
        .select()
        .from(schema.drafts)
        .where(eq(schema.drafts.kind, 'reply_dm'));
      expect(replyDrafts.length).toBe(1);
      const [syncedMessage] = await getDb()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.platformMessageId, 'real-1'));
      expect(replyDrafts[0].parentMessageId).toBe(syncedMessage.id);
    } finally {
      pool.query = originalQuery;
    }
  });
});

afterAll(async () => {
  await getPool().end();
});
