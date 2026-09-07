import { describe, expect, it, beforeEach } from 'vitest';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';
import { createDrafts, Payload } from '../../src/commands/drafts.js';

/**
 * Issue #336: a `post_comment` draft carried no `targetUser`, so marking it as
 * sent wrote no `contact_history` row even though the Inbox dialog said it
 * would, and the same author could be replied to again with nothing to notice
 * it. A comment is contact with the post's author, and `createDrafts` derives
 * that author from the run's own staged candidates instead of trusting the
 * playbook to copy the handle across.
 *
 * This runs against Postgres because the point is the ordering: the derived
 * target has to reach the blocklist and dedup checks, not just the row.
 */

async function reset() {
  const db = getDb();
  // Deliberately leaves `platforms` and the seeded `default` organization
  // alone: files share one database and run sequentially (see #373).
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, staging_scout_candidates RESTART IDENTITY CASCADE`,
  );
}

async function seed(platformSlug: string, skillSlug: string) {
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, platformSlug));
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `ct-${platformSlug}`, name: 'CT' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: project.id,
      platformId: platform.id,
      handle: 'ourhandle',
      role: 'personal',
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: project.id, platformId: platform.id, name: 'c', skillSlug, config: {} })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
    .returning();
  return { orgId: org.id, platformId: platform.id, projectId: project.id, account, run };
}

async function stage(runId: number, raw: Record<string, unknown>) {
  await getDb().insert(schema.stagingScoutCandidates).values({ runId, raw });
}

const PERMALINK = '/r/rpg/comments/abc/a_question/';

function redditComment(accountId: number, permalink = PERMALINK) {
  return {
    accountId,
    kind: 'post_comment' as const,
    subreddit: 'rpg',
    body: 'the answer is in the DMG appendix',
    sourceRef: { permalink },
    metadata: {},
  };
}

/** Parsed through the real `drafts_create` schema, so what the test sends is
 * what an agent could actually send (an omitted `targetUser` included). */
function payload(drafts: unknown[]) {
  return Payload.parse(drafts);
}

beforeEach(reset);

describe('createDrafts derives the post author of a comment (#336)', () => {
  it('records the staged candidate author as the target, so the sent comment can be logged', async () => {
    const { account, run } = await seed('reddit', 'reddit-commenter');
    await stage(run.id, {
      user: { name: 'alice' },
      post: { permalink: PERMALINK, title: 'a question' },
    });

    const res = await createDrafts(run.id, payload([redditComment(account.id)]));
    expect(res.inserted).toBe(1);

    const [draft] = await getDb().select().from(schema.drafts);
    expect(draft.targetUser).toBe('alice');
  });

  it('leaves the agent-supplied target alone rather than overwriting it', async () => {
    const { account, run } = await seed('reddit', 'reddit-commenter');
    await stage(run.id, { user: { name: 'alice' }, post: { permalink: PERMALINK } });

    await createDrafts(run.id, payload([{ ...redditComment(account.id), targetUser: 'bob' }]));

    const [draft] = await getDb().select().from(schema.drafts);
    expect(draft.targetUser).toBe('bob');
  });

  it('skips a comment on a post whose author is blocklisted', async () => {
    const { account, run, platformId, projectId } = await seed('reddit', 'reddit-commenter');
    await stage(run.id, { user: { name: 'alice' }, post: { permalink: PERMALINK } });
    await getDb().insert(schema.blocklist).values({
      platformId,
      projectId,
      kind: 'user',
      value: 'alice',
      reason: 'asked not to be contacted',
    });

    const res = await createDrafts(run.id, payload([redditComment(account.id)]));

    expect(res.inserted).toBe(0);
    expect(res.skipped).toEqual([{ targetUser: 'alice', reason: 'asked not to be contacted' }]);
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
  });

  it('warns on a comment addressed to someone already contacted inside the dedup window', async () => {
    const { account, run, platformId, orgId } = await seed('reddit', 'reddit-commenter');
    await stage(run.id, { user: { name: 'alice' }, post: { permalink: PERMALINK } });
    await getDb()
      .insert(schema.contactHistory)
      .values({
        platformId,
        organizationId: orgId,
        accountHandle: 'ourhandle',
        targetUser: 'alice',
        lastContactedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      });

    const res = await createDrafts(run.id, payload([redditComment(account.id)]));

    expect(res.inserted).toBe(1);
    const [draft] = await getDb().select().from(schema.drafts);
    expect(draft.targetUser).toBe('alice');
    expect(draft.dedupWarning).toContain('within 90d window');
  });

  it('leaves the target null when no staged candidate matches the draft', async () => {
    const { account, run } = await seed('reddit', 'reddit-commenter');
    await stage(run.id, {
      user: { name: 'alice' },
      post: { permalink: '/r/rpg/comments/zzz/another/' },
    });

    await createDrafts(run.id, payload([redditComment(account.id)]));

    const [draft] = await getDb().select().from(schema.drafts);
    expect(draft.targetUser).toBeNull();
  });

  it('derives a LinkedIn author from the post URN the draft carries', async () => {
    const { account, run } = await seed('linkedin', 'linkedin-commenter');
    await stage(run.id, {
      author: { handle: 'jane-doe', name: 'Jane Doe' },
      post: {
        externalId: 'urn:li:activity:123',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      },
    });

    await createDrafts(
      run.id,
      payload([
        {
          accountId: account.id,
          kind: 'post_comment',
          body: 'the second point matches what we saw',
          sourceRef: { externalId: 'urn:li:activity:123' },
          metadata: {},
        },
      ]),
    );

    const [draft] = await getDb().select().from(schema.drafts);
    expect(draft.targetUser).toBe('jane-doe');
  });
});
