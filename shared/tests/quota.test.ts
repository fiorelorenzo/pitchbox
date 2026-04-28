import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  getAccountUsage,
  getUsageForAccounts,
  isDraftKind,
  loadQuotaLimits,
  mapDraftKindToQuotaKind,
} from '../src/quota.js';
import { eq } from 'drizzle-orm';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

async function setup() {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'q-test', name: 'q-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'me' })
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

async function makeDraft(opts: {
  account: number;
  proj: number;
  platform: number;
  run: number;
  kind: 'dm' | 'post_comment' | 'comment_reply' | 'post';
  sentAt: Date | null;
}) {
  await getDb()
    .insert(schema.drafts)
    .values({
      runId: opts.run,
      projectId: opts.proj,
      platformId: opts.platform,
      accountId: opts.account,
      kind: opts.kind,
      state: opts.sentAt ? 'sent' : 'pending_review',
      body: 'x',
      sentAt: opts.sentAt,
    });
}

describe('isDraftKind', () => {
  it('returns true for known kinds and false for unknown ones', () => {
    expect(isDraftKind('dm')).toBe(true);
    expect(isDraftKind('comment_reply')).toBe(true);
    expect(isDraftKind('chat_dm')).toBe(false);
  });
});

describe('mapDraftKindToQuotaKind', () => {
  it('collapses post_comment and comment_reply into comment', () => {
    expect(mapDraftKindToQuotaKind('dm')).toBe('dm');
    expect(mapDraftKindToQuotaKind('post_comment')).toBe('comment');
    expect(mapDraftKindToQuotaKind('comment_reply')).toBe('comment');
    expect(mapDraftKindToQuotaKind('post')).toBe('post');
  });
});

describe('getAccountUsage', () => {
  beforeEach(reset);

  it('returns zeros when no drafts are sent', async () => {
    const { account, proj, platform, run } = await setup();
    await makeDraft({
      account: account.id,
      proj: proj.id,
      platform: platform.id,
      run: run.id,
      kind: 'dm',
      sentAt: null,
    });
    const u = await getAccountUsage(getDb(), account.id);
    expect(u.dm).toEqual({ day: 0, week: 0 });
    expect(u.comment).toEqual({ day: 0, week: 0 });
    expect(u.post).toEqual({ day: 0, week: 0 });
  });

  it('counts only sent_at within day/week windows and sums comment kinds', async () => {
    const { account, proj, platform, run } = await setup();
    const now = new Date('2026-04-27T12:00:00Z');
    const within24h = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const within7d = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    for (const ts of [within24h, within24h, within7d]) {
      await makeDraft({
        account: account.id,
        proj: proj.id,
        platform: platform.id,
        run: run.id,
        kind: 'dm',
        sentAt: ts,
      });
    }
    await makeDraft({
      account: account.id,
      proj: proj.id,
      platform: platform.id,
      run: run.id,
      kind: 'dm',
      sentAt: old,
    });
    await makeDraft({
      account: account.id,
      proj: proj.id,
      platform: platform.id,
      run: run.id,
      kind: 'post_comment',
      sentAt: within24h,
    });
    await makeDraft({
      account: account.id,
      proj: proj.id,
      platform: platform.id,
      run: run.id,
      kind: 'comment_reply',
      sentAt: within7d,
    });
    await makeDraft({
      account: account.id,
      proj: proj.id,
      platform: platform.id,
      run: run.id,
      kind: 'post',
      sentAt: within24h,
    });

    const u = await getAccountUsage(getDb(), account.id, now);
    expect(u.dm).toEqual({ day: 2, week: 3 });
    expect(u.comment).toEqual({ day: 1, week: 2 });
    expect(u.post).toEqual({ day: 1, week: 1 });
  });
});

describe('getUsageForAccounts', () => {
  beforeEach(reset);

  it('returns one entry per account id, including zero', async () => {
    const { account, proj, platform, run } = await setup();
    const [account2] = await getDb()
      .insert(schema.accounts)
      .values({ projectId: proj.id, platformId: platform.id, handle: 'other' })
      .returning();
    const now = new Date('2026-04-27T12:00:00Z');
    await makeDraft({
      account: account.id,
      proj: proj.id,
      platform: platform.id,
      run: run.id,
      kind: 'dm',
      sentAt: now,
    });

    const m = await getUsageForAccounts(getDb(), [account.id, account2.id], now);
    expect(m[account.id].dm.day).toBe(1);
    expect(m[account2.id]).toBeDefined();
    expect(m[account2.id].dm.day).toBe(0);
  });
});

describe('loadQuotaLimits', () => {
  it('reads quota_defaults from app_config', async () => {
    const limits = await loadQuotaLimits(getDb(), 'reddit');
    expect(limits.dm.perDay).toBe(10);
    expect(limits.comment.perDay).toBe(50);
    expect(limits.post.perDay).toBe(5);
  });

  it('returns all-fallback values when quota_defaults row is missing', async () => {
    const db = getDb();
    // Capture existing row so we can restore it
    const [existing] = await db
      .select({ value: schema.appConfig.value })
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, 'quota_defaults'));

    await db.delete(schema.appConfig).where(eq(schema.appConfig.key, 'quota_defaults'));

    try {
      const limits = await loadQuotaLimits(db, 'reddit');
      expect(limits.dm.perDay).toBe(10);
      expect(limits.comment.perDay).toBe(50);
      expect(limits.post.perDay).toBe(5);
    } finally {
      // Restore seeded row
      if (existing) {
        await db
          .insert(schema.appConfig)
          .values({ key: 'quota_defaults', value: existing.value })
          .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: existing.value } });
      }
    }
  });

  it('applies per-key fallback when platform blob is partial', async () => {
    const db = getDb();
    const [existing] = await db
      .select({ value: schema.appConfig.value })
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, 'quota_defaults'));

    const partial = { reddit: { dm: { perDay: 99, perWeek: 199 } } };
    await db
      .insert(schema.appConfig)
      .values({ key: 'quota_defaults', value: partial })
      .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: partial } });

    try {
      const limits = await loadQuotaLimits(db, 'reddit');
      expect(limits.dm.perDay).toBe(99);
      expect(limits.comment.perDay).toBe(50);
      expect(limits.post.perDay).toBe(5);
    } finally {
      if (existing) {
        await db
          .insert(schema.appConfig)
          .values({ key: 'quota_defaults', value: existing.value })
          .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: existing.value } });
      }
    }
  });

  it('returns fallback values for an unknown platform', async () => {
    const limits = await loadQuotaLimits(getDb(), 'twitter');
    expect(limits.dm.perDay).toBe(10);
    expect(limits.comment.perDay).toBe(50);
    expect(limits.post.perDay).toBe(5);
  });
});
