import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST } from '../src/routes/api/drafts/[id]/regenerate/cancel/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, draft_regeneration_hints RESTART IDENTITY CASCADE`,
  );
}

async function seedRegenerating() {
  const db = getDb();
  const [proj] = await db.insert(schema.projects).values({ slug: 'c', name: 'c' }).returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 't' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  const [origin] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'b',
      targetUser: 'someone',
      state: 'pending_review',
    })
    .returning();
  const [regen] = await db
    .insert(schema.runs)
    .values({
      kind: 'draft_regeneration',
      projectId: proj.id,
      trigger: 'manual',
      status: 'running',
      params: { draftId: draft.id },
    })
    .returning();
  await db
    .update(schema.drafts)
    .set({ regeneratingRunId: regen.id })
    .where(eq(schema.drafts.id, draft.id));
  return { draft };
}

describe('POST /api/drafts/[id]/regenerate/cancel', () => {
  beforeEach(reset);

  it('clears a stale regenerating flag when the in-memory cancel handle is gone', async () => {
    const { draft } = await seedRegenerating();
    // In a fresh test process the runCancels map is empty, so cancelRun returns false.
    const res = await POST({ params: { id: String(draft.id) } } as never);
    expect(res.status).toBe(200);
    const [fresh] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(fresh.regeneratingRunId).toBeNull();
  });

  it('409 when the draft is not regenerating', async () => {
    const { draft } = await seedRegenerating();
    await getDb()
      .update(schema.drafts)
      .set({ regeneratingRunId: null })
      .where(eq(schema.drafts.id, draft.id));
    const res = await POST({ params: { id: String(draft.id) } } as never);
    expect(res.status).toBe(409);
  });
});
