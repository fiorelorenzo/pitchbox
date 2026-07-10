import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST } from '../src/routes/api/drafts/[id]/regenerate/+server.js';

// The happy path spawns a real agent run, so it is covered by the shared
// (startDraftRegeneration) + cli (draft_regen_*) tests and the e2e verification.
// Here we only assert the route's guard/error behaviour, which never dispatches.

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, draft_regeneration_hints RESTART IDENTITY CASCADE`,
  );
}

async function seedDraft(state: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'r', name: 'r' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 't' })
    .returning();
  // The origin run's `kind` defaults to 'campaign', which the
  // `runs_kind_target_chk` check constraint requires a campaign_id for.
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
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
      kind: 'dm',
      body: 'b',
      targetUser: 'someone',
      state,
    })
    .returning();
  return draft;
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/drafts/1/regenerate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/drafts/[id]/regenerate (guards)', () => {
  beforeEach(reset);

  it('rejects an invalid id with 400', async () => {
    await expect(
      POST({ params: { id: 'abc' }, request: req({}), locals: {} } as never),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects a non-pending draft (does not dispatch)', async () => {
    const draft = await seedDraft('approved');
    await expect(
      POST({ params: { id: String(draft.id) }, request: req({ hint: 'x' }), locals: {} } as never),
    ).rejects.toMatchObject({ status: 400 });
    // No run was created for the draft.
    const runs = await getDb()
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.kind, 'draft_regeneration'));
    expect(runs.length).toBe(0);
  });
});
