import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  compilePattern,
  evaluateWatchFailure,
  tick,
  WATCH_FAILURE_THRESHOLD,
} from '../src/keyword-watcher.js';

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
  consecutiveFailures?: number;
  nextAttemptAfter?: Date | null;
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
      consecutiveFailures: opts.consecutiveFailures ?? 0,
      nextAttemptAfter: opts.nextAttemptAfter ?? null,
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

    it('backs off and notifies once a watch reaches the failure threshold', async () => {
      const { watch } = await seedWatch({
        pattern: 'pitchbox',
        consecutiveFailures: WATCH_FAILURE_THRESHOLD - 1,
      });
      const fetchListing = vi.fn().mockRejectedValue(new Error('reddit 429'));
      const triggerRun = vi.fn();

      await tick(fetchListing, triggerRun);

      const [row] = await getDb()
        .select()
        .from(schema.keywordWatches)
        .where(eq(schema.keywordWatches.id, watch.id));
      expect(row.consecutiveFailures).toBe(WATCH_FAILURE_THRESHOLD);
      expect(row.nextAttemptAfter).not.toBeNull();
      expect(row.nextAttemptAfter!.getTime()).toBeGreaterThan(Date.now());

      const [notif] = await getDb()
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, 'keyword_watch.failing'));
      expect(notif).toBeTruthy();
      expect((notif.payload as { watchId: number }).watchId).toBe(watch.id);
      expect(notif.severity).toBe('warning');
    });

    it('does not notify before the failure threshold is reached', async () => {
      await seedWatch({ pattern: 'pitchbox', consecutiveFailures: 0 });
      const fetchListing = vi.fn().mockRejectedValue(new Error('reddit 429'));
      const triggerRun = vi.fn();

      await tick(fetchListing, triggerRun);

      const [notif] = await getDb()
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, 'keyword_watch.failing'));
      expect(notif).toBeUndefined();
    });

    it('skips fetching a watch that is still backed off', async () => {
      const future = new Date(Date.now() + 60_000);
      await seedWatch({
        pattern: 'pitchbox',
        consecutiveFailures: WATCH_FAILURE_THRESHOLD,
        nextAttemptAfter: future,
      });
      const fetchListing = vi.fn();
      const triggerRun = vi.fn();

      const res = await tick(fetchListing, triggerRun);

      expect(fetchListing).not.toHaveBeenCalled();
      expect(res.dispatched).toBe(0);
    });

    it('resets the failure state on a successful fetch', async () => {
      const past = new Date(Date.now() - 60_000);
      const { watch } = await seedWatch({
        pattern: 'pitchbox',
        consecutiveFailures: WATCH_FAILURE_THRESHOLD,
        nextAttemptAfter: past,
      });
      const fetchListing = vi
        .fn()
        .mockResolvedValue(makeChildren([{ id: 'x', title: 'nothing relevant' }]));
      const triggerRun = vi.fn();

      await tick(fetchListing, triggerRun);

      const [row] = await getDb()
        .select()
        .from(schema.keywordWatches)
        .where(eq(schema.keywordWatches.id, watch.id));
      expect(row.consecutiveFailures).toBe(0);
      expect(row.nextAttemptAfter).toBeNull();
    });
  });

  describe('evaluateWatchFailure', () => {
    it('increments failures and backs off once the threshold is reached', () => {
      const now = new Date();
      const decision = evaluateWatchFailure(WATCH_FAILURE_THRESHOLD - 1, now);

      expect(decision.consecutiveFailures).toBe(WATCH_FAILURE_THRESHOLD);
      expect(decision.shouldNotify).toBe(true);
      expect(decision.nextAttemptAfter).not.toBeNull();
      expect(decision.nextAttemptAfter!.getTime()).toBeGreaterThan(now.getTime());
    });

    it('does not back off or notify below the threshold', () => {
      const now = new Date();
      const decision = evaluateWatchFailure(0, now);

      expect(decision.consecutiveFailures).toBe(1);
      expect(decision.shouldNotify).toBe(false);
      expect(decision.nextAttemptAfter).toBeNull();
    });

    it('only notifies on the tick that crosses the threshold, not every one after', () => {
      const now = new Date();
      const decision = evaluateWatchFailure(WATCH_FAILURE_THRESHOLD, now);

      expect(decision.consecutiveFailures).toBe(WATCH_FAILURE_THRESHOLD + 1);
      expect(decision.shouldNotify).toBe(false);
      expect(decision.nextAttemptAfter).not.toBeNull();
    });

    it('grows the backoff delay with further consecutive failures past the threshold', () => {
      const now = new Date();
      const first = evaluateWatchFailure(WATCH_FAILURE_THRESHOLD, now);
      const second = evaluateWatchFailure(WATCH_FAILURE_THRESHOLD + 1, now);

      expect(second.nextAttemptAfter!.getTime()).toBeGreaterThan(first.nextAttemptAfter!.getTime());
    });

    it('treats negative previous-failure counts as zero', () => {
      const now = new Date();
      const decision = evaluateWatchFailure(-5, now);
      expect(decision.consecutiveFailures).toBe(1);
    });
  });
});
