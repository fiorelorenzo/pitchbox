import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadConversations } from '../src/routes/conversations/+page.server.js';
import { load as loadThread } from '../src/routes/conversations/[id]/+page.server.js';
import { encodeThreadId } from '../src/routes/conversations/[id]/thread-id.js';

/**
 * Cross-tenant isolation for the Conversations pages. `contact_history` is a
 * global accepted residual (see docs/organization-isolation-design.md), so a
 * thread id reached by any org resolves to the same global contact row - but
 * the draft content attached to it must never render for an org that does
 * not own that draft.
 */

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE messages, contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Seeds an org with a project, a sent DM draft, a contact_history row
// attributed to that draft, and a message attributed to that draft too.
// With `withPendingReply`, also seeds a pending-review reply draft attached
// (via parentMessageId) to the inbound message, so loadPendingReplyDraft
// finds it.
async function seedOrgConversation(slug: string, opts: { withPendingReply?: boolean } = {}) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${slug}-proj`,
      name: `${slug} project`,
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(sql`slug = 'reddit'`);
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: `${slug}-cmp`,
      skillSlug: 'reddit-scout',
      status: 'active',
      config: {},
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: project.id,
      platformId: platform.id,
      handle: `${slug}-acc`,
      role: 'personal',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      projectId: project.id,
      agentRunner: 'claude-code',
      kind: 'campaign',
      trigger: 'manual',
      status: 'succeeded',
    })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      state: 'sent',
      targetUser: `${slug}-target`,
      body: `${slug}-secret-draft-body`,
    })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: `${slug}-acc`,
      targetUser: `${slug}-target`,
      draftId: draft.id,
      lastContactedAt: new Date('2026-05-01T10:00:00Z'),
      repliedAt: new Date('2026-05-02T10:00:00Z'),
    })
    .returning();
  const [, msgIn] = await db
    .insert(schema.messages)
    .values([
      {
        contactId: contact.id,
        draftId: draft.id,
        platformId: platform.id,
        author: `${slug}-acc`,
        isFromUs: true,
        body: `${slug}-secret-message-out`,
        platformMessageId: `${slug}-m1`,
        createdAtPlatform: new Date('2026-05-01T10:00:00Z'),
        source: 'test',
      },
      {
        contactId: contact.id,
        draftId: draft.id,
        platformId: platform.id,
        author: `${slug}-target`,
        isFromUs: false,
        body: `${slug}-secret-message-in`,
        platformMessageId: `${slug}-m2`,
        createdAtPlatform: new Date('2026-05-02T10:00:00Z'),
        source: 'test',
      },
    ])
    .returning();

  let pendingReplyDraftId: number | null = null;
  if (opts.withPendingReply) {
    const [replyDraft] = await db
      .insert(schema.drafts)
      .values({
        runId: run.id,
        projectId: project.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'reply_dm',
        state: 'pending_review',
        targetUser: `${slug}-target`,
        body: `${slug}-secret-reply-body`,
        parentMessageId: msgIn.id,
      })
      .returning();
    pendingReplyDraftId = replyDraft.id;
  }

  const threadId = encodeThreadId({
    accountHandle: `${slug}-acc`,
    targetUser: `${slug}-target`,
    platform: 'reddit',
  });
  return {
    orgId: org.id,
    projectId: project.id,
    draftId: draft.id,
    contactId: contact.id,
    threadId,
    pendingReplyDraftId,
  };
}

function fakeEvent(orgId: number, url: string, params: Record<string, string> = {}): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL(url),
    params,
  } as unknown as RequestEvent;
}

describe('conversations list is scoped to the active org', () => {
  beforeEach(reset);

  it('does not attach another org draft body/state to a cross-org contact row', async () => {
    const a = await seedOrgConversation('conv-list-a');
    const b = await seedOrgConversation('conv-list-b');

    const data = await loadConversations(fakeEvent(a.orgId, 'http://x/conversations'));
    const rowA = data.conversations.find((c: { contactId: number }) => c.contactId === a.contactId);
    const rowB = data.conversations.find((c: { contactId: number }) => c.contactId === b.contactId);

    expect(rowA).toBeTruthy();
    expect(rowA?.draftBody).toBe('conv-list-a-secret-draft-body');

    // contact_history itself stays global (accepted residual), so org B's
    // contact row may still be listed - but its draft content must be nulled.
    expect(rowB).toBeTruthy();
    expect(rowB?.draftBody).toBeNull();
    expect(rowB?.draftState).toBeNull();
    expect(rowB?.draftMetadata).toBeNull();
  });

  it('does not include another org message in the last-message preview', async () => {
    const a = await seedOrgConversation('conv-list-c');
    const b = await seedOrgConversation('conv-list-d');

    const data = await loadConversations(fakeEvent(a.orgId, 'http://x/conversations'));
    const rowA = data.conversations.find((c: { contactId: number }) => c.contactId === a.contactId);
    const rowB = data.conversations.find((c: { contactId: number }) => c.contactId === b.contactId);

    expect(rowA?.lastMessage?.body).toBe('conv-list-c-secret-message-in');
    expect(rowB?.lastMessage).toBeNull();
  });
});

describe('conversation thread detail is scoped to the active org', () => {
  beforeEach(reset);

  it('returns a null parentDraft for a thread whose draft belongs to another org', async () => {
    const a = await seedOrgConversation('conv-thread-a');
    const b = await seedOrgConversation('conv-thread-b');

    // org A reaches org B's thread id directly (contact_history is global, so
    // the thread lookup itself is not org-scoped).
    const data = await loadThread(
      fakeEvent(a.orgId, 'http://x/conversations/x', { id: b.threadId }),
    );

    expect(data.parentDraft).toBeNull();
  });

  it('returns the parentDraft for a same-org thread id', async () => {
    const a = await seedOrgConversation('conv-thread-c');

    const data = await loadThread(
      fakeEvent(a.orgId, 'http://x/conversations/x', { id: a.threadId }),
    );

    expect(data.parentDraft).toBeTruthy();
    expect(data.parentDraft?.body).toBe('conv-thread-c-secret-draft-body');
  });

  it('excludes messages attributed to another org draft from the thread', async () => {
    const a = await seedOrgConversation('conv-thread-d');
    const b = await seedOrgConversation('conv-thread-e');

    const data = await loadThread(
      fakeEvent(a.orgId, 'http://x/conversations/x', { id: b.threadId }),
    );

    const bodies = data.messages.map((m: { body: string }) => m.body);
    expect(bodies).not.toContain('conv-thread-e-secret-message-in');
    expect(bodies).not.toContain('conv-thread-e-secret-message-out');
  });

  it('returns a null replyDraft for a thread whose pending reply belongs to another org', async () => {
    const a = await seedOrgConversation('conv-thread-f');
    const b = await seedOrgConversation('conv-thread-g', { withPendingReply: true });

    const data = await loadThread(
      fakeEvent(a.orgId, 'http://x/conversations/x', { id: b.threadId }),
    );

    expect(data.replyDraft).toBeNull();
  });

  it('returns the replyDraft for a same-org pending reply', async () => {
    const a = await seedOrgConversation('conv-thread-h', { withPendingReply: true });

    const data = await loadThread(
      fakeEvent(a.orgId, 'http://x/conversations/x', { id: a.threadId }),
    );

    expect(data.replyDraft).toBeTruthy();
    expect(data.replyDraft?.body).toBe('conv-thread-h-secret-reply-body');
  });
});
