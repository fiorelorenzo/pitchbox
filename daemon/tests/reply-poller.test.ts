import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { tick as replyPollerTick } from '../src/reply-poller.js';
import { getReplyReader } from '../src/reply-readers.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, contact_history, projects RESTART IDENTITY CASCADE`,
  );
}

async function platformId(slug: string) {
  const [p] = await getDb().select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

describe('reply-poller', () => {
  beforeEach(reset);

  it('returns zero counts when nothing to check', async () => {
    const res = await replyPollerTick();
    expect(res).toEqual({ checked: 0, newReplies: 0, skipped: 0 });
  });

  it('null-reader path skips contacts and bumps reply_checked_at', async () => {
    const db = getDb();
    const pid = await platformId('reddit');
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [proj] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'rp-test', name: 'rp-test' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: proj.id, platformId: pid, handle: 'me' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ projectId: proj.id, platformId: pid, name: 'c', skillSlug: 's' })
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
        platformId: pid,
        accountId: account.id,
        kind: 'dm',
        state: 'sent',
        body: 'x',
      })
      .returning();
    const recent = new Date(Date.now() - 60 * 60_000); // 1h ago
    const [contact] = await db
      .insert(schema.contactHistory)
      .values({
        platformId: pid,
        accountHandle: 'me',
        targetUser: 'someone',
        draftId: draft.id,
        lastContactedAt: recent,
        replyCheckedAt: null,
        repliedAt: null,
      })
      .returning();

    // The null reader returns []; the poller should mark the contact as checked.
    const res = await replyPollerTick();
    expect(res.checked).toBe(1);
    expect(res.newReplies).toBe(0);
    // The reddit reader is registered as a NullReplyReader, which returns [].
    // It is NOT counted as "skipped" - that counter is for missing readers.
    expect(res.skipped).toBe(0);

    const [row] = await db
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.id, contact.id));
    expect(row.repliedAt).toBeNull();
    expect(row.replyCheckedAt).not.toBeNull();
  });

  it('returns the registered reader for reddit and null for unknown platforms', () => {
    const reddit = getReplyReader('reddit');
    expect(reddit).not.toBeNull();
    expect(reddit?.platform).toBe('reddit');

    const unknown = getReplyReader('does-not-exist');
    expect(unknown).toBeNull();
  });

  it('null reader returns an empty list', async () => {
    const reader = getReplyReader('reddit')!;
    const replies = await reader.readReplies({ accountHandle: 'me', since: new Date(0) });
    expect(replies).toEqual([]);
  });
});
