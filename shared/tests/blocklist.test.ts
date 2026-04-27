import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import { isBlocklisted } from '../src/blocklist.js';
import { eq } from 'drizzle-orm';

async function platformId(slug: string) {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

async function makeProject(slug: string) {
  const db = getDb();
  const [p] = await db
    .insert(schema.projects)
    .values({ slug, name: slug })
    .returning({ id: schema.projects.id });
  return p.id;
}

describe('isBlocklisted', () => {
  beforeEach(async () => {
    await getDb().delete(schema.blocklist);
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
    await getDb()
      .insert(schema.blocklist)
      .values({
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
