import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST } from '../src/routes/api/drafts/[id]/reply-draft/cancel/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seedDrafting() {
  const db = getDb();
  const [proj] = await db.insert(schema.projects).values({ slug: 'c', name: 'c' }).returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'us' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  const [origin] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [reply] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'reply_dm',
      body: '[reply pending]',
      targetUser: 'them',
      state: 'pending_review',
      parentMessageId: 1,
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'reply_drafting',
      projectId: proj.id,
      trigger: 'manual',
      status: 'running',
      params: { replyDraftId: reply.id, parentMessageId: 1 },
    })
    .returning();
  await db
    .update(schema.drafts)
    .set({ draftingRunId: run.id })
    .where(eq(schema.drafts.id, reply.id));
  return { reply, run };
}

describe('POST /api/drafts/[id]/reply-draft/cancel', () => {
  beforeEach(reset);

  it('marks an orphaned running drafting run cancelled WITHOUT clearing the flag', async () => {
    const { reply, run } = await seedDrafting();
    // Fresh test process: runCancels map is empty, so cancelRun returns false (orphaned).
    const res = await POST({ params: { id: String(reply.id) } } as never);
    expect(res.status).toBe(200);
    const [freshRun] = await getDb().select().from(schema.runs).where(eq(schema.runs.id, run.id));
    expect(freshRun.status).toBe('cancelled');
    const [freshDraft] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, reply.id));
    // Flag stays set: the placeholder must remain non-approvable.
    expect(freshDraft.draftingRunId).toBe(run.id);
  });

  it('409 when the draft is not drafting', async () => {
    const { reply } = await seedDrafting();
    await getDb()
      .update(schema.drafts)
      .set({ draftingRunId: null })
      .where(eq(schema.drafts.id, reply.id));
    const res = await POST({ params: { id: String(reply.id) } } as never);
    expect(res.status).toBe(409);
  });
});
