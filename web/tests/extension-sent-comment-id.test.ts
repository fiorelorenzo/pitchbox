import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as draftSent } from '../src/routes/api/extension/draft/[id]/sent/+server.js';

/**
 * Issue #337: `drafts.platform_comment_id` is what `shared/src/comment-sync.ts`
 * joins an incoming `t1` reply on, so a comment sent without it can never reach
 * `replied`. It used to be resolved server-side by fetching
 * `reddit.com/comments/<id>.json`, which answers 403 to any server-side fetch
 * (measured 2026-09-04 from a dev box and from inside the deployed container),
 * so it was never written at all. The id now comes from the content script that
 * watched the comment land, and this route records it.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
}

function sentRequest(id: number, token: string, body: Record<string, unknown>): Request {
  return new Request(`http://x/api/extension/draft/${id}/sent`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
}

async function mintDevice(token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({
      organizationId: null,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      label: 'test',
    });
}

async function seedCommentDraft() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'));
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `cid-${Date.now()}`, name: 'comment-id' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: `h-${Date.now()}` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform.id,
      name: 'comment-id',
      skillSlug: 'reddit-commenter',
    })
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
      platformId: platform.id,
      accountId: account.id,
      kind: 'post_comment',
      body: 'a public reply that says something',
      state: 'approved',
    })
    .returning();
  return draft;
}

async function readDraft(id: number) {
  const [row] = await getDb()
    .select({
      state: schema.drafts.state,
      version: schema.drafts.version,
      platformCommentId: schema.drafts.platformCommentId,
    })
    .from(schema.drafts)
    .where(eq(schema.drafts.id, id));
  return row;
}

describe('extension mark-sent route: the comment id the browser reports', () => {
  beforeEach(reset);

  it('records the id, and does not spend a version on it', async () => {
    const draft = await seedCommentDraft();
    await mintDevice('tok-ok');
    const before = await readDraft(draft.id);

    const res = await draftSent({
      params: { id: String(draft.id) },
      request: sentRequest(draft.id, 'tok-ok', { platformCommentId: 't1_p7rwpda' }),
    } as never);
    expect(res.status).toBe(200);

    const after = await readDraft(draft.id);
    expect(after.platformCommentId).toBe('t1_p7rwpda');
    expect(after.state).toBe('sent');
    // One bump for the send itself, none for the id: the extension may still be
    // holding the version it sent with, and this is an attribute, not a
    // transition.
    expect(after.version).toBe(before.version + 1);
  });

  it('sends fine without an id, leaving the column null rather than failing', async () => {
    const draft = await seedCommentDraft();
    await mintDevice('tok-none');

    const res = await draftSent({
      params: { id: String(draft.id) },
      request: sentRequest(draft.id, 'tok-none', {}),
    } as never);
    expect(res.status).toBe(200);

    const after = await readDraft(draft.id);
    expect(after.state).toBe('sent');
    expect(after.platformCommentId).toBeNull();
  });

  it.each([
    ['a post fullname', 't3_p7rwpda'],
    ['no prefix', 'p7rwpda'],
    ['a sql-shaped string', "t1_x'; drop table drafts; --"],
    ['empty', ''],
    ['a padded id', 't1_p7rwpda '],
  ])('ignores %s instead of storing it', async (_label, value) => {
    const draft = await seedCommentDraft();
    const token = `tok-${Math.random().toString(36).slice(2)}`;
    await mintDevice(token);

    const res = await draftSent({
      params: { id: String(draft.id) },
      request: sentRequest(draft.id, token, { platformCommentId: value }),
    } as never);
    // The send still succeeds - a malformed id is the extension's problem, not a
    // reason to leave a posted comment unrecorded.
    expect(res.status).toBe(200);

    const after = await readDraft(draft.id);
    expect(after.state).toBe('sent');
    // This column is joined on by the reply matcher, so a value that cannot be a
    // Reddit comment must never reach it: a `t3_` id would make every reply to
    // the post look like a reply to us.
    expect(after.platformCommentId).toBeNull();
  });
});
