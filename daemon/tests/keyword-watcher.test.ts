import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { compilePattern, tick } from '../src/keyword-watcher.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE keyword_watches, drafts, runs, campaigns, accounts, projects, notifications RESTART IDENTITY CASCADE`,
  );
}

async function seedWatch(opts: {
  subreddit?: string;
  pattern?: string;
  matchField?: 'title' | 'selftext' | 'comment';
  cooldownMinutes?: number;
  lastSeenAt?: Date | null;
}) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'kw-test', name: 'kw-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform!.id,
      name: 'kw-c',
      skillSlug: 'reddit-scout',
    })
    .returning();
  const [watch] = await db
    .insert(schema.keywordWatches)
    .values({
      projectId: proj.id,
      campaignId: campaign.id,
      subreddit: opts.subreddit ?? 'test',
      pattern: opts.pattern ?? 'pitchbox',
      matchField: opts.matchField ?? 'title',
      cooldownMinutes: opts.cooldownMinutes ?? 30,
      lastSeenAt: opts.lastSeenAt ?? null,
    })
    .returning();
  return { proj, campaign, watch };
}

function makeChildren(items: Array<{ id: string; title?: string; selftext?: string }>) {
  return items.map((d) => ({
    data: {
      id: d.id,
      name: `t3_${d.id}`,
      title: d.title ?? '',
      selftext: d.selftext ?? '',
      created_utc: Math.floor(Date.now() / 1000),
    },
  }));
}

describe('keyword-watcher', () => {
  beforeEach(async () => {
    await reset();
    vi.restoreAllMocks();
  });

  describe('compilePattern', () => {
    it('matches substrings case-insensitively', () => {
      const m = compilePattern('Pitchbox');
      expect(m('I love pitchbox today')).toBe(true);
      expect(m('nothing here')).toBe(false);
    });

    it('supports /regex/ syntax', () => {
      const m = compilePattern('/looking for (a |the )?tool/');
      expect(m('I am looking for a tool')).toBe(true);
      expect(m('looking for nothing')).toBe(false);
    });

    it('falls back to substring on invalid regex', () => {
      const m = compilePattern('/[unclosed/');
      // Bad regex falls through to substring lookup of the raw pattern.
      expect(m('foo /[unclosed/ bar')).toBe(true);
    });
  });

  describe('tick', () => {
    it('dispatches the campaign when the pattern matches a fresh post', async () => {
      const { campaign } = await seedWatch({ pattern: 'pitchbox' });
      const fetchListing = vi.fn().mockResolvedValue(
        makeChildren([
          { id: 'abc', title: 'pitchbox is great' },
          { id: 'def', title: 'unrelated post' },
        ]),
      );
      const triggerRun = vi.fn().mockResolvedValue(true);

      const res = await tick(fetchListing, triggerRun);

      expect(res.checked).toBe(1);
      expect(res.dispatched).toBe(1);
      expect(triggerRun).toHaveBeenCalledWith(
        campaign.id,
        expect.objectContaining({ postId: 't3_abc', title: 'pitchbox is great' }),
      );
    });

    it('skips watches whose cooldown has not elapsed', async () => {
      // lastSeenAt 5 minutes ago, cooldown 30 minutes → must skip.
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
      await seedWatch({ lastSeenAt: fiveMinAgo, cooldownMinutes: 30 });
      const fetchListing = vi.fn();
      const triggerRun = vi.fn();

      const res = await tick(fetchListing, triggerRun);

      expect(fetchListing).not.toHaveBeenCalled();
      expect(triggerRun).not.toHaveBeenCalled();
      expect(res.dispatched).toBe(0);
    });

    it('does not dispatch when no post matches', async () => {
      await seedWatch({ pattern: 'pitchbox' });
      const fetchListing = vi
        .fn()
        .mockResolvedValue(makeChildren([{ id: 'x', title: 'nothing relevant' }]));
      const triggerRun = vi.fn().mockResolvedValue(true);

      const res = await tick(fetchListing, triggerRun);

      expect(res.dispatched).toBe(0);
      expect(triggerRun).not.toHaveBeenCalled();
    });
  });
});
