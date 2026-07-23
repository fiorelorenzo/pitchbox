import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as dmSyncPost } from '../src/routes/api/extension/dm-sync/+server.js';

/**
 * Issue #170 (dm-sync matching leg): a device token bound to org A must not be
 * able to match, flip, or attach messages to org B's drafts/contacts via a
 * crafted dm-sync payload. The candidate queries (contact_history, accounts,
 * drafts) are scoped to the device's org through draft -> project -> org; a
 * null-org device (self-host) keeps full access.
 */

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

// Seed an org with an account + a sent DM draft + a contact_history row that an
// inbound reply (fromUser=target, toUser=handle) would match.
async function seedOrg(slug: string, handle: string, target: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: slug, skillSlug: 'reddit-scout' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hi',
      targetUser: target,
      state: 'sent',
      sentAt: new Date(),
    })
    .returning();
  await db.insert(schema.contactHistory).values({
    platformId: platform.id,
    accountHandle: handle,
    targetUser: target,
    lastContactedAt: new Date(Date.now() - 60 * 60 * 1000),
    draftId: draft.id,
    repliedAt: null,
  });
  return { org, proj, account, campaign, run, platform, draft };
}

// Seed a comment-reply draft (t1 channel) and/or a reddit-poster draft (t3
// channel) under an already-seeded org, so the comment path has a candidate an
// incoming `comments[]` payload could try to flip.
async function seedCommentDraft(
  seed: Awaited<ReturnType<typeof seedOrg>>,
  opts: { platformCommentId?: string; platformPostId?: string; kind: string },
) {
  const db = getDb();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: seed.run.id,
      projectId: seed.proj.id,
      platformId: seed.platform.id,
      accountId: seed.account.id,
      kind: opts.kind,
      body: 'a comment we left',
      state: 'sent',
      sentAt: new Date(),
      platformCommentId: opts.platformCommentId ?? null,
      platformPostId: opts.platformPostId ?? null,
    })
    .returning();
  return draft;
}

function commentSyncRequest(token: string, parentCommentId: string, author: string): Request {
  return new Request('http://x/api/extension/dm-sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'reddit',
      items: [],
      comments: [
        {
          parentCommentId,
          replyCommentId: `t1_reply_${parentCommentId}`,
          author,
          body: 'a reply to our comment',
          createdAt: new Date().toISOString(),
          contextUrl: 'https://reddit.com/r/x/comments/abc/_/def',
        },
      ],
    }),
  });
}

async function callComment(token: string, parentCommentId: string, author: string) {
  return dmSyncPost({
    request: commentSyncRequest(token, parentCommentId, author),
  } as unknown as Parameters<typeof dmSyncPost>[0]);
}

function syncRequest(token: string, handle: string, target: string): Request {
  return new Request('http://x/api/extension/dm-sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'reddit',
      items: [
        {
          fromUser: target,
          toUser: handle,
          body: 'a reply',
          threadId: `${handle}-${target}-1`,
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  });
}

async function call(token: string, handle: string, target: string) {
  return dmSyncPost({
    request: syncRequest(token, handle, target),
  } as unknown as Parameters<typeof dmSyncPost>[0]);
}

describe('POST /api/extension/dm-sync: cross-tenant matching scope (#170)', () => {
  beforeEach(reset);

  it("a device for org A cannot match/flip org B's contact", async () => {
    await seedOrg('org-b', 'b_handle', 'b_target');
    const { org: orgA } = await seedOrg('org-a', 'a_handle', 'a_target');
    await mintDevice(orgA.id, 'tokA');

    // Craft a payload that matches ORG B's contact (b_handle/b_target).
    const res = await call('tokA', 'b_handle', 'b_target');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replied: number };
    expect(body.replied).toBe(0); // org B's contact is out of scope

    const events = await getDb().select().from(schema.draftEvents);
    expect(events.length).toBe(0);
    const msgs = await getDb().select().from(schema.messages);
    expect(msgs.length).toBe(0);
  });

  it("a device for org A CAN match its own org's contact", async () => {
    await seedOrg('org-b', 'b_handle', 'b_target');
    const { org: orgA } = await seedOrg('org-a', 'a_handle', 'a_target');
    await mintDevice(orgA.id, 'tokA');

    const res = await call('tokA', 'a_handle', 'a_target');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replied: number };
    expect(body.replied).toBe(1);
  });

  it('a null-org device (self-host) matches without org scoping', async () => {
    const { org: orgA } = await seedOrg('org-a', 'a_handle', 'a_target');
    void orgA;
    await mintDevice(null, 'tokNull');

    const res = await call('tokNull', 'a_handle', 'a_target');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replied: number };
    expect(body.replied).toBe(1);
  });
});

describe('POST /api/extension/dm-sync: cross-tenant comment scope (#170)', () => {
  beforeEach(reset);

  it("a device for org A cannot flip org B's comment-reply draft (t1 channel)", async () => {
    const seedB = await seedOrg('org-b', 'b_handle', 'b_target');
    await seedCommentDraft(seedB, { platformCommentId: 't1_bbb', kind: 'comment' });
    const { org: orgA } = await seedOrg('org-a', 'a_handle', 'a_target');
    await mintDevice(orgA.id, 'tokA');

    // Reply whose parent is org B's own comment id - out of org A's scope.
    const res = await callComment('tokA', 't1_bbb', 'someone');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsReplied: number; commentsInserted: number };
    expect(body.commentsReplied).toBe(0);
    expect(body.commentsInserted).toBe(0);

    expect((await getDb().select().from(schema.draftEvents)).length).toBe(0);
    expect((await getDb().select().from(schema.messages)).length).toBe(0);
  });

  it("a device for org A cannot flip org B's reddit-poster draft (t3 channel)", async () => {
    const seedB = await seedOrg('org-b', 'b_handle', 'b_target');
    await seedCommentDraft(seedB, { platformPostId: 't3_bbb', kind: 'post' });
    const { org: orgA } = await seedOrg('org-a', 'a_handle', 'a_target');
    await mintDevice(orgA.id, 'tokA');

    // Top-level reply on org B's submission (parent == its t3 id) - out of scope.
    const res = await callComment('tokA', 't3_bbb', 'someone');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsReplied: number; commentsInserted: number };
    expect(body.commentsReplied).toBe(0);
    expect(body.commentsInserted).toBe(0);

    expect((await getDb().select().from(schema.draftEvents)).length).toBe(0);
    expect((await getDb().select().from(schema.messages)).length).toBe(0);
  });

  it("a device for org A CAN flip its own org's comment-reply draft", async () => {
    await seedOrg('org-b', 'b_handle', 'b_target');
    const seedA = await seedOrg('org-a', 'a_handle', 'a_target');
    const draftA = await seedCommentDraft(seedA, { platformCommentId: 't1_aaa', kind: 'comment' });
    await mintDevice(seedA.org.id, 'tokA');

    const res = await callComment('tokA', 't1_aaa', 'someone');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsReplied: number; commentsInserted: number };
    expect(body.commentsReplied).toBe(1);
    expect(body.commentsInserted).toBe(1);

    const events = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draftA.id));
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('replied');
  });
});

afterAll(async () => {
  await getPool().end();
});
