import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { startReplyDrafting } from '@pitchbox/shared/reply-drafter';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seedReplyDraft() {
  const db = getDb();
  const [proj] = await db.insert(schema.projects).values({ slug: 'r', name: 'r' }).returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'us' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  const [origin] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      agentRunner: 'gemini',
      trigger: 'manual',
      status: 'success',
    })
    .returning();
  const [parent] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'original outreach',
      targetUser: 'them',
      state: 'sent',
    })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: account.handle,
      targetUser: 'them',
      draftId: parent.id,
    })
    .returning();
  const [inbound] = await db
    .insert(schema.messages)
    .values({
      contactId: contact.id,
      draftId: parent.id,
      platformId: platform.id,
      author: 'them',
      isFromUs: false,
      body: 'thanks, tell me more',
      platformMessageId: 'm1',
      createdAtPlatform: new Date(),
      source: 'legacy',
    })
    .returning();
  const [reply] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'reply_dm',
      body: '[reply pending - agent run not yet executed]',
      targetUser: 'them',
      state: 'pending_review',
      parentMessageId: inbound.id,
      sourceRef: { kind: 'reply', parentDraftId: parent.id, parentMessageId: inbound.id },
    })
    .returning();
  return { reply, inbound, parent };
}

describe('startReplyDrafting', () => {
  beforeEach(reset);

  it('creates a reply_drafting run, sets the flag, inherits the runner', async () => {
    const db = getDb();
    const { reply, inbound } = await seedReplyDraft();
    const { run, alreadyRunning } = await startReplyDrafting(db, {
      replyDraftId: reply.id,
      parentMessageId: inbound.id,
    });
    expect(alreadyRunning).toBe(false);
    expect(run.kind).toBe('reply_drafting');
    expect(run.status).toBe('running');
    expect(run.agentRunner).toBe('gemini');
    expect((run.params as { replyDraftId: number }).replyDraftId).toBe(reply.id);

    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, reply.id));
    expect(fresh.draftingRunId).toBe(run.id);
  });

  it('returns alreadyRunning when a drafting run is still running', async () => {
    const db = getDb();
    const { reply, inbound } = await seedReplyDraft();
    const first = await startReplyDrafting(db, {
      replyDraftId: reply.id,
      parentMessageId: inbound.id,
    });
    const second = await startReplyDrafting(db, {
      replyDraftId: reply.id,
      parentMessageId: inbound.id,
    });
    expect(second.alreadyRunning).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it('replaces a terminal (failed) drafting run so Retry works', async () => {
    const db = getDb();
    const { reply, inbound } = await seedReplyDraft();
    const first = await startReplyDrafting(db, {
      replyDraftId: reply.id,
      parentMessageId: inbound.id,
    });
    await db.update(schema.runs).set({ status: 'failed' }).where(eq(schema.runs.id, first.run.id));
    const second = await startReplyDrafting(db, {
      replyDraftId: reply.id,
      parentMessageId: inbound.id,
    });
    expect(second.alreadyRunning).toBe(false);
    expect(second.run.id).not.toBe(first.run.id);
  });

  it('rejects a non-reply draft', async () => {
    const db = getDb();
    const { parent, inbound } = await seedReplyDraft();
    await expect(
      startReplyDrafting(db, { replyDraftId: parent.id, parentMessageId: inbound.id }),
    ).rejects.toThrow();
  });
});
