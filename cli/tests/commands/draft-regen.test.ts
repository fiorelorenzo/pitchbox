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
  it('start returns the draft, hint, and platform - no rubric template, since scoring is no longer self-reported', () => {
    const parsed = lastJson(cli(`drafts:regen:start --run=${regenRunId}`));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.draftId).toBe(draftId);
    expect(parsed.data.hint).toBe('shorter');
    expect(parsed.data.platform).toBe('reddit');
    expect(parsed.data.draft.body).toBe('old body');
    expect(parsed.data.rubricTemplate).toBeUndefined();
  });

  it('finish overwrites the body, bumps version + count, clears the flag, ends the run, and recomputes the quality score server-side', async () => {
    const out = cliWithStdin(
      `drafts:regen:finish --run=${regenRunId}`,
      JSON.stringify({ body: 'new body' }),
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
    // No style findings and no operator voice corpus in this fixture - the
    // deterministic scorer has nothing to measure, so it reports "not
    // scored" rather than guessing a number.
    expect(d.qualityScore).toBeNull();
    expect(d.qualityModel).toBeNull();

    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, regenRunId));
    expect(r.status).toBe('success');
    expect(r.finishedAt).not.toBeNull();

    const [evt] = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draftId));
    expect(evt.event).toBe('regenerated');
    expect((evt.details as { previousBody: string }).previousBody).toBe('old body');
  });

  it('finish caps the score below green when the rewritten body carries a style finding, never trusting a self-report', async () => {
    const out = cliWithStdin(
      `drafts:regen:finish --run=${regenRunId}`,
      JSON.stringify({
        body: "In today's fast-paced world, it's worth noting the update shipped.",
      }),
    );
    expect(lastJson(out).ok).toBe(true);

    const db = getDb();
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
    expect(d.qualityModel).toBe('deterministic');
    expect(d.qualityScore).not.toBeNull();
    expect(d.qualityScore).toBeLessThan(75);
  });

  it('finish measures echo and language match against the source text the original draft carried, when present (LOR-251)', async () => {
    const db = getDb();
    const postText =
      'We just shipped the new expense reconciliation workflow after months of testing and everyone on the team is relieved it finally works end to end.';
    await db
      .update(schema.drafts)
      .set({ sourceRef: { permalink: '/r/x/1', sourceText: postText } })
      .where(eq(schema.drafts.id, draftId));

    // The "in today's fast-paced world" clause is a known style finding,
    // which caps the score at an integer regardless of the axis average -
    // this test is about the echo/language-match axes, not about
    // exercising every score value the deterministic scorer can reach.
    const out = cliWithStdin(
      `drafts:regen:finish --run=${regenRunId}`,
      JSON.stringify({
        body: "In today's fast-paced world, congrats on shipping the new expense reconciliation workflow for the whole team.",
      }),
    );
    expect(lastJson(out).ok).toBe(true);

    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
    const detail = (d.metadata as Record<string, unknown>).qualityDetail as {
      deterministic: {
        sourceMeasured: boolean;
        languageMatch: boolean | null;
        distance: { echo: number | null };
      };
    };
    expect(detail.deterministic.sourceMeasured).toBe(true);
    expect(detail.deterministic.distance.echo).not.toBeNull();
    expect(detail.deterministic.distance.echo as number).toBeGreaterThan(0);
    expect(detail.deterministic.languageMatch).toBe(true);
  });

  it('finish rejects an empty body', () => {
    expect(() =>
      cliWithStdin(`drafts:regen:finish --run=${regenRunId}`, JSON.stringify({ body: '  ' })),
    ).toThrow();
  });

  // LOR-294: `draftRegenFinish` used to call `checkStyle`/`scoreDraftQuality`
  // with no `expectedLanguage`, so a regenerated draft scored and was
  // checked differently from a created one even though both answer to the
  // same pinned campaign. Body is the LOR-291 fixture shape - short enough
  // that `classifyLanguage` alone reads it as 'unknown', which is exactly
  // the case the pin exists to settle. Before this issue an `unknown`
  // verdict ran both phrase lists (a spurious English "leverage" finding
  // alongside the real Italian one) and scored with no expected language
  // recorded at all - both wrong for a campaign that pinned Italian.
  it('finish threads the campaign language pin into both the style checker and the quality score (LOR-294)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [proj] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p-lor294', name: 'P294' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: proj.id, platformId: platform.id, handle: 'a294' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: proj.id,
        platformId: platform.id,
        name: 'c294',
        skillSlug: 'reddit-scout',
        config: { voice: { language: 'it' } },
      })
      .returning();
    const [origin] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
      .returning();
    const body = 'Sinergia forte qui, complimenti, leverage forte.';
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
    // A draft_regeneration run copies its campaignId forward from the
    // draft's origin run (shared/src/draft-regenerate.ts's
    // startDraftRegeneration) - reproduced by hand here since this test
    // inserts the run directly rather than calling that function.
    const [regen] = await db
      .insert(schema.runs)
      .values({
        kind: 'draft_regeneration',
        campaignId: campaign.id,
        projectId: proj.id,
        trigger: 'manual',
        status: 'running',
        params: { draftId: draft.id, hint: null },
      })
      .returning();

    const out = cliWithStdin(`drafts:regen:finish --run=${regen.id}`, JSON.stringify({ body }));
    expect(lastJson(out).ok).toBe(true);

    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    const metadata = d.metadata as {
      styleFindings?: Array<{ ruleId: string; message: string; span: string }>;
    };
    // Checked: only the Italian rule list ran - the pin excludes the
    // English list outright, so "leverage" (a real English-list phrase
    // too) never ships as a second, spurious finding.
    const puffery = metadata.styleFindings!.filter((f) => f.ruleId === 'puffery');
    expect(puffery).toHaveLength(1);
    expect(puffery[0]?.span).toBe('Sinergia');
    expect(puffery[0]?.message).toContain('(Italian)');
    // Scored: the quality axis recorded the pin as the expected language,
    // not the null it falls back to with no post and no pin.
    const detail = (d.metadata as Record<string, unknown>).qualityDetail as {
      deterministic: { expectedLanguage: string | null };
    };
    expect(detail.deterministic.expectedLanguage).toBe('it');
  });
});
