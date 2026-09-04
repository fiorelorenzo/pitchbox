// #221: a run whose agent exited 0 is only a success if the playbook reached the
// tool that commits its result. These cases pin the per-kind contract.
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '../../src/db/client.js';
import { playbookContractError } from '../../src/runlog/contract.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function fixtures() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'contract', name: 'contract' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'c',
      skillSlug: 'reddit-scout',
    })
    .returning();
  return { db, project, platform, campaign };
}

describe('playbookContractError', () => {
  beforeEach(reset);

  // `runs_kind_target_chk` decides which target column each kind carries:
  // skill generation hangs off a campaign, the rest off a project.
  it.each([
    ['project_extraction', 'project_extract_finish'],
    ['project_insights', 'project_insights'],
    ['draft_regeneration', 'draft_regen_finish'],
    ['reply_drafting', 'reply_draft_finish'],
    ['campaign_skill_generation', 'skill_generate_finish'],
  ])('a %s run that never called %s saved nothing', async (kind, tool) => {
    const { db, project, campaign } = await fixtures();
    const target =
      kind === 'campaign_skill_generation'
        ? { campaignId: campaign.id }
        : { projectId: project.id };
    const [run] = await db
      .insert(schema.runs)
      .values({ kind, ...target, trigger: 'manual', status: 'running' })
      .returning();

    const err = await playbookContractError(db, run);
    expect(err).toContain(tool);
    expect(err).toContain('saved nothing');
  });

  it('a campaign run that drafted nothing and never closed the run is incomplete', async () => {
    const { db, campaign } = await fixtures();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const err = await playbookContractError(db, run);
    expect(err).toContain('run_finish');
    expect(err).toContain('without creating any draft');
  });

  it('a campaign run that drafted keeps its success even without run_finish', async () => {
    const { db, project, platform, campaign } = await fixtures();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'contractuser' })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();
    await db.insert(schema.drafts).values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
    });

    expect(await playbookContractError(db, run)).toBeNull();
  });

  it('drafts from another run do not count', async () => {
    const { db, project, platform, campaign } = await fixtures();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'contractuser2' })
      .returning();
    const [drafted] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
      .returning();
    const [empty] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();
    await db.insert(schema.drafts).values({
      runId: drafted.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
    });

    expect(await playbookContractError(db, empty)).toContain('without creating any draft');
  });

  it('says nothing about a kind with no finish tool', async () => {
    const { db } = await fixtures();
    expect(await playbookContractError(db, { id: 1, kind: 'something_else' })).toBeNull();
  });

  // #313: an assist run has no playbook and no agent that could call a finish
  // tool at all, unlike every other kind above. It is deliberately absent
  // from PLAYBOOK_FINISH_TOOL rather than mapped to one, so this exercises the
  // real row shape (kind: 'assist', a bare project, no campaign) rather than
  // the synthetic 'something_else' case above.
  it('an assist run is never classified playbook_incomplete', async () => {
    const { db, project } = await fixtures();
    const [run] = await db
      .insert(schema.runs)
      .values({ kind: 'assist', projectId: project.id, trigger: 'manual', status: 'running' })
      .returning();

    expect(await playbookContractError(db, run)).toBeNull();
  });
});

afterAll(async () => {
  await getPool().end();
});
