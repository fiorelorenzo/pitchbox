import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  load as loadPeople,
  type PeoplePageData,
  type ThreadsTabData,
} from '../src/routes/people/+page.server.js';
import { load as loadThread } from '../src/routes/conversations/[id]/+page.server.js';
import { encodeThreadId } from '../src/routes/conversations/[id]/thread-id.js';

/**
 * Cross-tenant isolation for the Conversations pages. `contact_history.
 * organization_id` is NOT NULL and always matches the org of the row's
 * draft's project (#263), so both the People page's threads tab and the
 * thread-detail route (`/conversations/[id]`) must exclude a cross-org
 * contact row entirely, rather than resolving it with draft/message fields
 * nulled out - see docs/organization-isolation-design.md.
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
      organizationId: org.id,
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

// `/people`'s loader returns a discriminated union keyed on `tab`
// (contacts-shaped vs. threads-shaped data - see +page.server.ts); narrow
// on the real discriminant rather than asserting the whole result.
function asThreadsTab(data: PeoplePageData): ThreadsTabData {
  if (data.tab !== 'threads') throw new Error('expected the threads tab');
  return data;
}

describe('conversations list is scoped to the active org', () => {
  beforeEach(reset);

  it('excludes a cross-org contact row entirely from the conversations list', async () => {
    const a = await seedOrgConversation('conv-list-a');
    const b = await seedOrgConversation('conv-list-b');

    const data = asThreadsTab(await loadPeople(fakeEvent(a.orgId, 'http://x/people')));
    const rowA = data.conversations.find((c: { contactId: number }) => c.contactId === a.contactId);
    const rowB = data.conversations.find((c: { contactId: number }) => c.contactId === b.contactId);

    expect(rowA).toBeTruthy();
    expect(rowA?.draftBody).toBe('conv-list-a-secret-draft-body');

    // contact_history is org-scoped (#263): org B's contact row must not
    // appear at all when loading as org A.
    expect(rowB).toBeUndefined();
  });

  it('does not leak another org message into the caller org conversations list', async () => {
    const a = await seedOrgConversation('conv-list-c');
    const b = await seedOrgConversation('conv-list-d');

    const data = asThreadsTab(await loadPeople(fakeEvent(a.orgId, 'http://x/people')));
    const rowA = data.conversations.find((c: { contactId: number }) => c.contactId === a.contactId);
    const rowB = data.conversations.find((c: { contactId: number }) => c.contactId === b.contactId);

    expect(rowA?.lastMessage?.body).toBe('conv-list-c-secret-message-in');
    // contact_history is org-scoped (#263): org B's row (and its message)
    // must not appear at all when loading as org A.
    expect(rowB).toBeUndefined();
  });
});

describe('conversation thread detail is scoped to the active org', () => {
  beforeEach(reset);

  it('404s a cross-org thread id rather than leaking the draft attached to it', async () => {
    const a = await seedOrgConversation('conv-thread-a');
    const b = await seedOrgConversation('conv-thread-b');

    // org A reaches org B's thread id: contact_history is org-scoped (#263),
    // so the lookup itself now 404s instead of resolving org B's contact
    // row with the draft nulled out.
    await expect(
      loadThread(fakeEvent(a.orgId, 'http://x/conversations/x', { id: b.threadId })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns the parentDraft for a same-org thread id', async () => {
    const a = await seedOrgConversation('conv-thread-c');

    const data = await loadThread(
      fakeEvent(a.orgId, 'http://x/conversations/x', { id: a.threadId }),
    );

    expect(data.parentDraft).toBeTruthy();
    expect(data.parentDraft?.body).toBe('conv-thread-c-secret-draft-body');
  });

  it('404s a cross-org thread id rather than leaking its messages', async () => {
    const a = await seedOrgConversation('conv-thread-d');
    const b = await seedOrgConversation('conv-thread-e');

    // contact_history is org-scoped (#263): org A can no longer reach org
    // B's thread id at all, so its messages never load in the first place.
    await expect(
      loadThread(fakeEvent(a.orgId, 'http://x/conversations/x', { id: b.threadId })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('404s a cross-org thread id rather than leaking its pending reply draft', async () => {
    const a = await seedOrgConversation('conv-thread-f');
    const b = await seedOrgConversation('conv-thread-g', { withPendingReply: true });

    await expect(
      loadThread(fakeEvent(a.orgId, 'http://x/conversations/x', { id: b.threadId })),
    ).rejects.toMatchObject({ status: 404 });
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
