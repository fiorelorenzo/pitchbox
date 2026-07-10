import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, { encoding: 'utf8', cwd: process.cwd() });
}
function cliWithStdin(args: string, input: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input,
    cwd: process.cwd(),
  });
}
function lastJson(out: string) {
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

let draftId: number;
let regenRunId: number;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, draft_regeneration_hints RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  await reset();
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'a' })
    .returning();
  // The origin run represents whatever run originally created the draft. It
  // defaults to kind 'campaign', which the runs_kind_target_chk constraint
  // requires a campaign_id for, so give it one.
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'C', skillSlug: 'reddit-scout' })
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
      body: 'old body',
      targetUser: 'someone',
      state: 'pending_review',
    })
    .returning();
  draftId = draft.id;
  const [regen] = await db
    .insert(schema.runs)
    .values({
      kind: 'draft_regeneration',
      projectId: proj.id,
      trigger: 'manual',
      status: 'running',
      params: { draftId, hint: 'shorter' },
    })
    .returning();
  regenRunId = regen.id;
  await db
    .update(schema.drafts)
    .set({ regeneratingRunId: regen.id })
    .where(eq(schema.drafts.id, draftId));
});

afterAll(async () => {
  await getPool().end();
});

describe('pitchbox drafts:regen:*', () => {
  it('start returns the draft, hint, platform, and rubric template', () => {
    const parsed = lastJson(cli(`drafts:regen:start --run=${regenRunId}`));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.draftId).toBe(draftId);
    expect(parsed.data.hint).toBe('shorter');
    expect(parsed.data.platform).toBe('reddit');
    expect(parsed.data.draft.body).toBe('old body');
    expect(typeof parsed.data.rubricTemplate).toBe('string');
    expect(parsed.data.rubricTemplate.length).toBeGreaterThan(0);
  });

  it('finish overwrites the body, bumps version + count, clears the flag, ends the run, and re-scores', async () => {
    const out = cliWithStdin(
      `drafts:regen:finish --run=${regenRunId}`,
      JSON.stringify({ body: 'new body', qualityScore: 70, qualityReason: 'tightened' }),
    );
    const parsed = lastJson(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.regenerationCount).toBe(1);

    const db = getDb();
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
    expect(d.body).toBe('new body');
    expect(d.version).toBe(1);
    expect(d.regenerationCount).toBe(1);
    expect(d.regeneratingRunId).toBeNull();
    expect(d.qualityScore).toBe(70);
    expect(d.qualityReason).toBe('tightened');

    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, regenRunId));
    expect(r.status).toBe('success');
    expect(r.finishedAt).not.toBeNull();
    expect(d.qualityModel).toBe(r.agentRunner);

    const [evt] = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draftId));
    expect(evt.event).toBe('regenerated');
    expect((evt.details as { previousBody: string }).previousBody).toBe('old body');
  });

  it('finish rejects an empty body', () => {
    expect(() =>
      cliWithStdin(`drafts:regen:finish --run=${regenRunId}`, JSON.stringify({ body: '  ' })),
    ).toThrow();
  });
});
