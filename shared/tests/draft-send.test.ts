import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { evaluateDraftSend, type DraftLike } from '../src/draft-send.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

async function setup() {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'ds-test', name: 'ds-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'testuser' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  return { proj, platform, account, run };
}

async function makeSentDraft(opts: {
  account: number;
  proj: number;
  platform: number;
  run: number;
  kind: 'dm' | 'post_comment' | 'comment_reply' | 'post';
  sentAt: Date;
}) {
  await getDb()
    .insert(schema.drafts)
    .values({
      runId: opts.run,
      projectId: opts.proj,
      platformId: opts.platform,
      accountId: opts.account,
      kind: opts.kind,
      state: 'sent',
      body: 'x',
      sentAt: opts.sentAt,
    });
}

describe('evaluateDraftSend', () => {
  beforeEach(reset);

  it('returns blocked when target is on blocklist', async () => {
    const db = getDb();
    const { proj, platform, account } = await setup();

    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      kind: 'user',
      value: 'spammer',
      scope: 'global',
      reason: 'known spammer',
    });

    const draft: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: 'spammer',
      kind: 'dm',
    };

    const result = await evaluateDraftSend(db, draft);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toBe('known spammer');
    }
  });

  it('returns ok with null quotaEventDetails when below limit', async () => {
    const db = getDb();
    const { proj, platform, account } = await setup();

    const draft: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: 'someuser',
      kind: 'dm',
    };

    const result = await evaluateDraftSend(db, draft);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.quotaEventDetails).toBeNull();
    }
  });

  it('returns over-quota details when daily limit would be breached', async () => {
    const db = getDb();
    const { proj, platform, account, run } = await setup();
    const now = new Date('2026-04-27T12:00:00Z');

    // Pre-seed 10 sent DM drafts in last 24h (perDay=10)
    for (let i = 0; i < 10; i++) {
      const sentAt = new Date(now.getTime() - (i + 1) * 60 * 60 * 1000); // within last 24h
      await makeSentDraft({
        account: account.id,
        proj: proj.id,
        platform: platform.id,
        run: run.id,
        kind: 'dm',
        sentAt,
      });
    }

    const draft: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: 'newuser',
      kind: 'dm',
    };

    const result = await evaluateDraftSend(db, draft, now);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.quotaEventDetails).not.toBeNull();
      expect(result.quotaEventDetails).toMatchObject({
        quotaExceeded: true,
        kind: 'dm',
        usage: { day: 11, week: 11 },
        limit: { perDay: 10, perWeek: 50 },
      });
    }
  });

  it('returns over-quota details when weekly limit would be breached but daily is fine', async () => {
    const db = getDb();
    const { proj, platform, account, run } = await setup();
    const now = new Date('2026-04-27T12:00:00Z');

    // Pre-seed 50 sent DM drafts at >24h and <=7d ago (so day=0, week=50)
    for (let i = 0; i < 50; i++) {
      // 2 days ago + spread
      const sentAt = new Date(now.getTime() - (2 * 24 + i * 0.1) * 60 * 60 * 1000);
      await makeSentDraft({
        account: account.id,
        proj: proj.id,
        platform: platform.id,
        run: run.id,
        kind: 'dm',
        sentAt,
      });
    }

    const draft: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: 'weeklyuser',
      kind: 'dm',
    };

    const result = await evaluateDraftSend(db, draft, now);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.quotaEventDetails).not.toBeNull();
      expect(result.quotaEventDetails).toMatchObject({
        quotaExceeded: true,
        kind: 'dm',
        usage: { day: 1, week: 51 },
        limit: { perDay: 10, perWeek: 50 },
      });
    }
  });

  it('comment kind sums post_comment + comment_reply for the cap', async () => {
    const db = getDb();
    const { proj, platform, account, run } = await setup();
    const now = new Date('2026-04-27T12:00:00Z');

    // Pre-seed 50 sent post_comment drafts in last 24h (perDay for comment = 50)
    for (let i = 0; i < 50; i++) {
      const sentAt = new Date(now.getTime() - (i + 1) * 60 * 1000); // within last hour
      await makeSentDraft({
        account: account.id,
        proj: proj.id,
        platform: platform.id,
        run: run.id,
        kind: 'post_comment',
        sentAt,
      });
    }

    // Test with a fresh post_comment draft → over (50+1>50)
    const draftPostComment: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: null,
      kind: 'post_comment',
    };

    const result1 = await evaluateDraftSend(db, draftPostComment, now);
    expect(result1.kind).toBe('ok');
    if (result1.kind === 'ok') {
      expect(result1.quotaEventDetails).not.toBeNull();
      expect(result1.quotaEventDetails!.quotaExceeded).toBe(true);
      expect(result1.quotaEventDetails!.kind).toBe('comment');
    }

    // Test with a fresh comment_reply draft → also over
    const draftCommentReply: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: null,
      kind: 'comment_reply',
    };

    const result2 = await evaluateDraftSend(db, draftCommentReply, now);
    expect(result2.kind).toBe('ok');
    if (result2.kind === 'ok') {
      expect(result2.quotaEventDetails).not.toBeNull();
      expect(result2.quotaEventDetails!.quotaExceeded).toBe(true);
      expect(result2.quotaEventDetails!.kind).toBe('comment');
    }
  });

  it('skips blocklist check when targetUser is null', async () => {
    const db = getDb();
    const { proj, platform, account } = await setup();

    // Add a blocklist entry for some other user — should not affect null targetUser
    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      kind: 'user',
      value: 'otheruser',
      scope: 'global',
    });

    const draft: DraftLike = {
      platformId: platform.id,
      projectId: proj.id,
      accountId: account.id,
      targetUser: null,
      kind: 'dm',
    };

    const result = await evaluateDraftSend(db, draft);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.quotaEventDetails).toBeNull();
    }
  });
});
