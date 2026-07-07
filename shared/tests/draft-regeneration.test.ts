import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { startDraftRegeneration, clearDraftRegeneration } from '@pitchbox/shared/draft-regenerate';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events, draft_regeneration_hints RESTART IDENTITY CASCADE`,
  );
}

async function seedDraft(state = 'pending_review') {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'regen', name: 'regen' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'tester' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  const [origin] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      agentRunner: 'gemini',
      trigger: 'manual',
      status: 'success',
    })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'first take',
      targetUser: 'someone',
      state,
    })
    .returning();
  return { draft, origin };
}

describe('startDraftRegeneration', () => {
  beforeEach(reset);

  it('creates a draft_regeneration run, sets the flag, persists the hint, inherits the runner', async () => {
    const db = getDb();
    const { draft } = await seedDraft();
    const { run, alreadyRunning } = await startDraftRegeneration(db, {
      draftId: draft.id,
      hint: 'make it shorter',
    });
    expect(alreadyRunning).toBe(false);
    expect(run.kind).toBe('draft_regeneration');
    expect(run.status).toBe('running');
    expect(run.agentRunner).toBe('gemini');
    expect((run.params as { draftId: number }).draftId).toBe(draft.id);

    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(fresh.regeneratingRunId).toBe(run.id);

    const [hint] = await db
      .select()
      .from(schema.draftRegenerationHints)
      .where(eq(schema.draftRegenerationHints.draftId, draft.id));
    expect(hint.hintText).toBe('make it shorter');
  });

  it('returns alreadyRunning when a regeneration is already in flight', async () => {
    const db = getDb();
    const { draft } = await seedDraft();
    const first = await startDraftRegeneration(db, { draftId: draft.id });
    const second = await startDraftRegeneration(db, { draftId: draft.id });
    expect(second.alreadyRunning).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    const runsForDraft = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.kind, 'draft_regeneration'));
    expect(runsForDraft.length).toBe(1);
  });

  it('rejects a draft that is not pending_review', async () => {
    const db = getDb();
    const { draft } = await seedDraft('approved');
    await expect(startDraftRegeneration(db, { draftId: draft.id })).rejects.toThrow();
  });

  it('clearDraftRegeneration nulls the flag', async () => {
    const db = getDb();
    const { draft } = await seedDraft();
    const { run } = await startDraftRegeneration(db, { draftId: draft.id });
    await clearDraftRegeneration(db, draft.id);
    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(fresh.regeneratingRunId).toBeNull();
    expect(run.id).toBeGreaterThan(0);
  });
});
