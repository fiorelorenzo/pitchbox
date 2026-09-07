import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { PATCH } from '../src/routes/inbox/[id]/+server.js';

/**
 * Issue #336: marking a `post_comment` as sent left `contact_history` empty,
 * so nothing recorded that the author had been engaged, the dedup window never
 * saw them, and the dialog's "logged to contact history" was false. Comment
 * drafts now carry the post's author as `targetUser` (derived in
 * `createDrafts`), and this is the assertion that the promise holds: one row,
 * naming that author, on the platform the draft belongs to.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seedCommentDraft(targetUser: string | null) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'comment-contact', name: 'comment-contact' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'ourhandle' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform.id,
      name: 'c',
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
      body: 'the answer is in the DMG appendix',
      targetUser,
      sourceRef: { permalink: '/r/rpg/comments/abc/a_question/' },
      state: 'approved',
    })
    .returning();
  return { org, platform, draft };
}

function patchEvent(id: number, body: unknown): RequestEvent {
  return {
    locals: {},
    params: { id: String(id) },
    request: new Request(`http://localhost/inbox/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as RequestEvent;
}

describe('marking a comment as sent logs contact history (#336)', () => {
  beforeEach(reset);

  it('writes exactly one row naming the post author', async () => {
    const { org, platform, draft } = await seedCommentDraft('alice');

    const res = await PATCH(patchEvent(draft.id, { state: 'sent', version: draft.version }));
    expect(res.status).toBe(200);

    const contacts = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draft.id));
    expect(contacts).toHaveLength(1);
    expect(contacts[0].targetUser).toBe('alice');
    expect(contacts[0].accountHandle).toBe('ourhandle');
    expect(contacts[0].platformId).toBe(platform.id);
    expect(contacts[0].organizationId).toBe(org.id);
  });

  it('writes nothing when the comment has no author to name, so the row is never invented', async () => {
    const { draft } = await seedCommentDraft(null);

    const res = await PATCH(patchEvent(draft.id, { state: 'sent', version: draft.version }));
    expect(res.status).toBe(200);

    expect(await getDb().select().from(schema.contactHistory)).toHaveLength(0);
  });
});
