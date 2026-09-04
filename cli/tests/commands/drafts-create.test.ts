import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, stdin?: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input: stdin,
    cwd: process.cwd(),
  });
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

describe('pitchbox drafts:create', () => {
  beforeEach(reset);

  it('bulk-inserts drafts from stdin JSON', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo', name: 'D' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'alice', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        fitScore: 4,
        subreddit: 'rpg',
        targetUser: 'bob',
        body: 'hey bob, ...',
        reasoning: 'matched post',
        composeUrl: 'https://reddit.com/message/compose?to=bob&subject=hi',
        sourceRef: { permalink: '/r/rpg/p/1' },
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].state).toBe('pending_review');
    expect(drafts[0].targetUser).toBe('bob');
    expect(drafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
    // issue #325: the agent-supplied composeUrl above is never honoured -
    // drafts_create builds its own server-side from targetUser + body, so
    // it can never disagree with the reviewed body. `message=` decodes back
    // to exactly `body`.
    expect(drafts[0].composeUrl).not.toBe('https://reddit.com/message/compose?to=bob&subject=hi');
    const composeUrl = new URL(drafts[0].composeUrl!);
    expect(composeUrl.origin + composeUrl.pathname).toBe('https://www.reddit.com/message/compose');
    expect(composeUrl.searchParams.get('to')).toBe('bob');
    expect(composeUrl.searchParams.get('message')).toBe('hey bob, ...');
    // No qualityScore supplied - persists as null (not scored).
    expect(drafts[0].qualityScore).toBeNull();
    expect(drafts[0].qualityReason).toBeNull();
    expect(drafts[0].qualityModel).toBeNull();
  });

  it('persists an inline quality score supplied at creation (issue #41)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo3', name: 'D3' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'carol', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c3',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'dave',
        body: 'hey dave, ...',
        sourceRef: {},
        metadata: {},
        qualityScore: 82,
        qualityReason: 'specific and personal',
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].qualityScore).toBe(82);
    expect(drafts[0].qualityReason).toBe('specific and personal');
    expect(drafts[0].qualityModel).toBe(run.agentRunner);
  });

  it('skips blocklisted targets and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo2', name: 'D2' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c2',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Insert blocklist entry for 'Bob' (mixed case) - should block 'bob' (lowercase) in the input
    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'user',
      value: 'Bob',
      scope: 'global',
      reason: 'asked-not-to-contact',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'alice',
        body: 'hey alice, ...',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'bob',
        body: 'hey bob, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].targetUser).toBe('bob');
    expect(res.data.skipped[0].reason).toBe('asked-not-to-contact');

    // Only alice's draft should be in the DB; no draft or draft_event for bob
    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetUser).toBe('alice');
    const events = await db.select().from(schema.draftEvents);
    expect(events).toHaveLength(1);
    expect(events[0].draftId).toBe(drafts[0].id);
  });

  it('skips drafts targeting a blocklisted subreddit and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-sub', name: 'DemoSub' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender-sub',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c-sub',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'subreddit',
      value: 'CryptoCurrency',
      scope: 'global',
      reason: 'off-topic subreddit',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'rpg',
        body: 'a post about rpgs',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'cryptocurrency',
        body: 'a post about crypto',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].reason).toBe('off-topic subreddit');

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
  });

  it('skips drafts whose body or title contains a blocklisted keyword and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-kw', name: 'DemoKw' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender-kw',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c-kw',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'keyword',
      value: 'giveaway',
      scope: 'global',
      reason: 'spammy keyword',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'rpg',
        title: 'A normal post',
        body: 'nothing special here',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'rpg',
        title: 'Huge Giveaway inside!',
        body: 'come check it out',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].reason).toBe('spammy keyword');

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe('A normal post');
  });

  it('rejects a draft whose accountId belongs to a different project (issue #107)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);

    // Project A owns the campaign/run.
    const [projectA] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'proj-a', name: 'Project A' })
      .returning();
    const [accountA] = await db
      .insert(schema.accounts)
      .values({
        projectId: projectA.id,
        platformId: platform.id,
        handle: 'a-owner',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: projectA.id,
        platformId: platform.id,
        name: 'ca',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Project B owns a foreign account that should never be attributable to
    // project A's drafts.
    const [projectB] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'proj-b', name: 'Project B' })
      .returning();
    const [accountB] = await db
      .insert(schema.accounts)
      .values({
        projectId: projectB.id,
        platformId: platform.id,
        handle: 'b-owner',
        role: 'personal',
      })
      .returning();

    // Foreign accountId is rejected: the whole batch fails with a clear error
    // and nothing is persisted.
    const foreignPayload = JSON.stringify([
      {
        accountId: accountB.id,
        kind: 'dm',
        targetUser: 'eve',
        body: 'hey eve, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    let threw = false;
    try {
      cli(`drafts:create --run=${run.id}`, foreignPayload);
    } catch (err) {
      threw = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/account/i);
      expect(res.error).toMatch(new RegExp(String(accountB.id)));
    }
    expect(threw).toBe(true);

    const draftsAfterForeign = await db.select().from(schema.drafts);
    expect(draftsAfterForeign).toHaveLength(0);

    // Same-project accountId succeeds as before.
    const samePayload = JSON.stringify([
      {
        accountId: accountA.id,
        kind: 'dm',
        targetUser: 'frank',
        body: 'hey frank, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, samePayload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const draftsAfterSame = await db.select().from(schema.drafts);
    expect(draftsAfterSame).toHaveLength(1);
    expect(draftsAfterSame[0].accountId).toBe(accountA.id);
  });

  it('rejects Reddit post/post_comment drafts with no subreddit, accepts them with one, and leaves dm untouched (issue #258)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'sub-guard', name: 'Sub Guard' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'carol', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-commenter',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Reject: no subreddit anywhere on a post_comment draft. The whole batch
    // fails and nothing is persisted.
    const missingPayload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        targetUser: null,
        body: 'a comment about rpgs',
        sourceRef: {},
        metadata: {},
      },
    ]);

    let threw = false;
    try {
      cli(`drafts:create --run=${run.id}`, missingPayload);
    } catch (err) {
      threw = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/subreddit/i);
      expect(res.error).toMatch(/post_comment/);
    }
    expect(threw).toBe(true);
    expect(await db.select().from(schema.drafts)).toHaveLength(0);

    // Reject: same for a top-level "post" draft.
    const missingPostPayload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        targetUser: null,
        title: 'A post with nowhere to go',
        body: 'body text',
        sourceRef: {},
        metadata: {},
      },
    ]);
    let postThrew = false;
    try {
      cli(`drafts:create --run=${run.id}`, missingPostPayload);
    } catch (err) {
      postThrew = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/subreddit/i);
    }
    expect(postThrew).toBe(true);
    expect(await db.select().from(schema.drafts)).toHaveLength(0);

    // Accept: subreddit supplied via the top-level field (reddit-commenter.md's convention).
    const withTopLevelSubreddit = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        subreddit: 'rpg',
        targetUser: null,
        body: 'a comment about rpgs',
        sourceRef: {},
        metadata: {},
      },
    ]);
    const out1 = cli(`drafts:create --run=${run.id}`, withTopLevelSubreddit);
    const res1 = JSON.parse(out1.trim().split('\n').at(-1)!);
    expect(res1.ok).toBe(true);
    expect(res1.data.inserted).toBe(1);

    // Accept: subreddit supplied inline in metadata (reddit-poster.md's convention).
    const withMetadataSubreddit = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        targetUser: null,
        title: 'A post with somewhere to go',
        body: 'body text',
        sourceRef: {},
        metadata: { subreddit: 'cryptocurrency' },
      },
    ]);
    const out2 = cli(`drafts:create --run=${run.id}`, withMetadataSubreddit);
    const res2 = JSON.parse(out2.trim().split('\n').at(-1)!);
    expect(res2.ok).toBe(true);
    expect(res2.data.inserted).toBe(1);

    // Unaffected: dm drafts legitimately have no subreddit and are never
    // subject to this guard even on the Reddit platform.
    const dmPayload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'dave',
        body: 'hey dave, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);
    const out3 = cli(`drafts:create --run=${run.id}`, dmPayload);
    const res3 = JSON.parse(out3.trim().split('\n').at(-1)!);
    expect(res3.ok).toBe(true);
    expect(res3.data.inserted).toBe(1);

    const finalDrafts = await db.select().from(schema.drafts).orderBy(schema.drafts.id);
    expect(finalDrafts).toHaveLength(3);
    expect(finalDrafts[0].kind).toBe('post_comment');
    expect(finalDrafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
    expect(finalDrafts[1].kind).toBe('post');
    expect(finalDrafts[1].metadata).toMatchObject({ subreddit: 'cryptocurrency' });
    expect(finalDrafts[2].kind).toBe('dm');
    expect(finalDrafts[2].targetUser).toBe('dave');
  });
});

afterAll(async () => {
  await getPool().end();
});
