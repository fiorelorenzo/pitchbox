import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, schema } from '../src/db/client.js';
import { enqueueReplyDraft, loadPendingReplyDraft } from '../src/reply-drafter.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, messages RESTART IDENTITY CASCADE`,
  );
}

async function setup() {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'rd-test', name: 'rd-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'rduser' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [parentDraft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'original outbound dm',
      targetUser: 'bob',
      state: 'replied',
    })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: account.handle,
      targetUser: 'bob',
      draftId: parentDraft.id,
    })
    .returning();
  const [inboundMsg] = await db
    .insert(schema.messages)
    .values({
      contactId: contact.id,
      draftId: parentDraft.id,
      platformId: platform.id,
      author: 'bob',
      isFromUs: false,
      body: 'thanks, interesting - can you say more?',
      platformMessageId: 't1_inbound_1',
      createdAtPlatform: new Date(),
      source: 'legacy',
    })
    .returning();
  return { db, parentDraft, inboundMsg, contact };
}

describe('reply-drafter', () => {
  beforeEach(reset);

  it('creates a reply_dm draft with parent_message_id and a draft_event', async () => {
    const { db, parentDraft, inboundMsg } = await setup();
    const res = await enqueueReplyDraft(db, {
      parentDraftId: parentDraft.id,
      parentMessageId: inboundMsg.id,
      replyKind: 'reply_dm',
    });
    expect(res).not.toBeNull();
    const [reply] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, res!.draftId));
    expect(reply.kind).toBe('reply_dm');
    expect(reply.parentMessageId).toBe(inboundMsg.id);
    expect(reply.state).toBe('pending_review');
    const events = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, reply.id));
    expect(events.some((e) => e.event === 'reply_drafting_enqueued')).toBe(true);
  });

  it('is idempotent: a second call for the same parentMessageId is a no-op', async () => {
    const { db, parentDraft, inboundMsg } = await setup();
    await enqueueReplyDraft(db, {
      parentDraftId: parentDraft.id,
      parentMessageId: inboundMsg.id,
      replyKind: 'reply_dm',
    });
    const second = await enqueueReplyDraft(db, {
      parentDraftId: parentDraft.id,
      parentMessageId: inboundMsg.id,
      replyKind: 'reply_dm',
    });
    expect(second).toBeNull();
  });

  it('loadPendingReplyDraft surfaces the newest pending reply for a contact', async () => {
    const { db, parentDraft, inboundMsg, contact } = await setup();
    await enqueueReplyDraft(db, {
      parentDraftId: parentDraft.id,
      parentMessageId: inboundMsg.id,
      replyKind: 'reply_dm',
    });
    const found = await loadPendingReplyDraft(db, contact.id);
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('reply_dm');
    expect(found!.parentMessageId).toBe(inboundMsg.id);
  });

  it('playbook prompt references conversation history and parent message id', () => {
    const path = join(process.cwd(), 'playbooks', 'reply-drafter.md');
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('PITCHBOX_REPLY_DRAFT_ID');
    expect(body).toContain('PITCHBOX_PARENT_MESSAGE_ID');
    expect(body.toLowerCase()).toContain('conversation history');
  });
});
