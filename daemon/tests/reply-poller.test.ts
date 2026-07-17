import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  NullReplyReader,
  type Reply,
  type ReplyReader,
} from '@pitchbox/shared/platforms/reply-reader';
import { tick as replyPollerTick } from '../src/reply-poller.js';
import {
  getActiveReplyReaderPlatforms,
  getReplyReader,
  registerReplyReader,
} from '../src/reply-readers.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, contact_history, projects RESTART IDENTITY CASCADE`,
  );
}

async function platformId(slug: string) {
  const [p] = await getDb().select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

/** Insert a full chain (project/account/campaign/run/draft/contact) so a
 * contact_history row has everything the poller joins against. */
async function insertContact(platformSlug: string, targetUser: string) {
  const db = getDb();
  const pid = await platformId(platformSlug);
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `rp-test-${platformSlug}`,
      name: `rp-test-${platformSlug}`,
    })
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
      targetUser,
      draftId: draft.id,
      lastContactedAt: recent,
      replyCheckedAt: null,
      repliedAt: null,
    })
    .returning();
  return contact;
}

async function contactRow(id: number) {
  const [row] = await getDb()
    .select()
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.id, id));
  return row;
}

describe('reply-poller', () => {
  beforeEach(reset);

  it('returns zero counts when nothing to check', async () => {
    const res = await replyPollerTick();
    expect(res).toEqual({ checked: 0, newReplies: 0, skipped: 0 });
  });

  it('skips the poll cycle entirely when only Null readers are registered', async () => {
    const contact = await insertContact('reddit', 'someone');

    // Reddit's registered reader is a NullReplyReader - the poller should skip
    // the platform up front (fast no-op) instead of querying and touching it.
    // Reply detection for Reddit happens via the Chrome extension instead.
    const res = await replyPollerTick();
    expect(res).toEqual({ checked: 0, newReplies: 0, skipped: 0 });

    const row = await contactRow(contact.id);
    expect(row.repliedAt).toBeNull();
    expect(row.replyCheckedAt).toBeNull();
  });

  it('polls a platform with a real reader while skipping a Null-reader platform', async () => {
    const fakeReader: ReplyReader = {
      platform: 'hackernews',
      async readReplies(): Promise<Reply[]> {
        return [{ targetUser: 'replier', at: new Date() }];
      },
    };
    registerReplyReader(fakeReader);

    try {
      const nullContact = await insertContact('reddit', 'someone');
      const realContact = await insertContact('hackernews', 'replier');

      const res = await replyPollerTick();
      expect(res.checked).toBe(1);
      expect(res.newReplies).toBe(1);
      expect(res.skipped).toBe(0);

      const nullRow = await contactRow(nullContact.id);
      expect(nullRow.replyCheckedAt).toBeNull();

      const realRow = await contactRow(realContact.id);
      expect(realRow.repliedAt).not.toBeNull();
      expect(realRow.replyCheckedAt).not.toBeNull();
    } finally {
      // Restore hackernews to a Null reader so later tests see the default state.
      registerReplyReader(new NullReplyReader('hackernews'));
    }
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

  describe('getActiveReplyReaderPlatforms', () => {
    afterEach(() => {
      registerReplyReader(new NullReplyReader('hackernews'));
    });

    it('excludes Null readers and includes real ones', () => {
      // Mastodon is registered as a real reader by default (see reply-readers.ts).
      expect(getActiveReplyReaderPlatforms()).toEqual(['mastodon']);

      registerReplyReader({
        platform: 'hackernews',
        async readReplies() {
          return [];
        },
      });
      expect(getActiveReplyReaderPlatforms()).toEqual(['mastodon', 'hackernews']);
    });
  });

  it('registers a real (non-Null) reply reader for mastodon', () => {
    const mastodon = getReplyReader('mastodon');
    expect(mastodon).not.toBeNull();
    expect(mastodon?.platform).toBe('mastodon');
    expect(getActiveReplyReaderPlatforms()).toContain('mastodon');
  });
});
