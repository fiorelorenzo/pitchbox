import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import { isBlocklisted, isSubredditBlocklisted, isKeywordBlocklisted } from '../src/blocklist.js';
import { eq, sql } from 'drizzle-orm';

async function platformId(slug: string) {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

async function makeProject(slug: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [p] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug, name: slug })
    .returning({ id: schema.projects.id });
  return p.id;
}

describe('isBlocklisted', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE blocklist, projects RESTART IDENTITY CASCADE`);
  });

  it('returns blocked=false when no entry matches', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-test-empty');
    const r = await isBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      targetUser: 'alice',
    });
    expect(r.blocked).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('matches case-insensitively on user kind', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-test-ci');
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: pid, kind: 'user', value: 'Alice', scope: 'global', reason: 'spam' });
    const r = await isBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      targetUser: 'alice',
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('spam');
  });

  it('respects project scope', async () => {
    const pid = await platformId('reddit');
    const projA = await makeProject('blk-test-a');
    const projB = await makeProject('blk-test-b');
    await getDb().insert(schema.blocklist).values({
      platformId: pid,
      kind: 'user',
      value: 'bob',
      scope: 'project',
      projectId: projA,
      reason: null,
    });

    const inA = await isBlocklisted(getDb(), {
      platformId: pid,
      projectId: projA,
      targetUser: 'bob',
    });
    const inB = await isBlocklisted(getDb(), {
      platformId: pid,
      projectId: projB,
      targetUser: 'bob',
    });
    expect(inA.blocked).toBe(true);
    expect(inB.blocked).toBe(false);
  });

  it('global entries apply across projects', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-test-global');
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: pid, kind: 'user', value: 'charlie', scope: 'global' });
    const r = await isBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      targetUser: 'charlie',
    });
    expect(r.blocked).toBe(true);
  });

  it('ignores non-user kinds', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-test-kinds');
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: pid, kind: 'subreddit', value: 'cats', scope: 'global' });
    const r = await isBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      targetUser: 'cats',
    });
    expect(r.blocked).toBe(false);
  });
});

describe('isSubredditBlocklisted', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE blocklist, projects RESTART IDENTITY CASCADE`);
  });

  it('returns blocked=false when no entry matches', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-sub-empty');
    const r = await isSubredditBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      subreddit: 'rpg',
    });
    expect(r.blocked).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('matches case-insensitively on subreddit kind', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-sub-ci');
    await getDb().insert(schema.blocklist).values({
      platformId: pid,
      kind: 'subreddit',
      value: 'CryptoCurrency',
      scope: 'global',
      reason: 'off-topic',
    });
    const r = await isSubredditBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      subreddit: 'cryptocurrency',
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('off-topic');
  });

  it('respects project scope', async () => {
    const pid = await platformId('reddit');
    const projA = await makeProject('blk-sub-a');
    const projB = await makeProject('blk-sub-b');
    await getDb().insert(schema.blocklist).values({
      platformId: pid,
      kind: 'subreddit',
      value: 'rpg',
      scope: 'project',
      projectId: projA,
      reason: null,
    });

    const inA = await isSubredditBlocklisted(getDb(), {
      platformId: pid,
      projectId: projA,
      subreddit: 'rpg',
    });
    const inB = await isSubredditBlocklisted(getDb(), {
      platformId: pid,
      projectId: projB,
      subreddit: 'rpg',
    });
    expect(inA.blocked).toBe(true);
    expect(inB.blocked).toBe(false);
  });

  it('ignores non-subreddit kinds', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-sub-kinds');
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: pid, kind: 'user', value: 'rpg', scope: 'global' });
    const r = await isSubredditBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      subreddit: 'rpg',
    });
    expect(r.blocked).toBe(false);
  });
});

describe('isKeywordBlocklisted', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE blocklist, projects RESTART IDENTITY CASCADE`);
  });

  it('returns blocked=false when no entry matches', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-kw-empty');
    const r = await isKeywordBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      text: 'a totally normal message',
    });
    expect(r.blocked).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('matches case-insensitively as a substring of the text', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-kw-ci');
    await getDb().insert(schema.blocklist).values({
      platformId: pid,
      kind: 'keyword',
      value: 'CryptoScam',
      scope: 'global',
      reason: 'banned topic',
    });
    const r = await isKeywordBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      text: 'check out this cryptoscam opportunity',
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('banned topic');
  });

  it('respects project scope', async () => {
    const pid = await platformId('reddit');
    const projA = await makeProject('blk-kw-a');
    const projB = await makeProject('blk-kw-b');
    await getDb().insert(schema.blocklist).values({
      platformId: pid,
      kind: 'keyword',
      value: 'nsfw',
      scope: 'project',
      projectId: projA,
      reason: null,
    });

    const inA = await isKeywordBlocklisted(getDb(), {
      platformId: pid,
      projectId: projA,
      text: 'this post is nsfw',
    });
    const inB = await isKeywordBlocklisted(getDb(), {
      platformId: pid,
      projectId: projB,
      text: 'this post is nsfw',
    });
    expect(inA.blocked).toBe(true);
    expect(inB.blocked).toBe(false);
  });

  it('ignores non-keyword kinds', async () => {
    const pid = await platformId('reddit');
    const proj = await makeProject('blk-kw-kinds');
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: pid, kind: 'user', value: 'nsfw', scope: 'global' });
    const r = await isKeywordBlocklisted(getDb(), {
      platformId: pid,
      projectId: proj,
      text: 'this post is nsfw',
    });
    expect(r.blocked).toBe(false);
  });
});
