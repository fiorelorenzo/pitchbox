import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';
import { classifyLanguage } from '@pitchbox/shared/assist/voice-profile';

function cli(args: string, stdin?: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input: stdin,
    cwd: process.cwd(),
  });
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

describe('pitchbox drafts:create', () => {
  beforeEach(reset);

  it('bulk-inserts drafts from stdin JSON', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo', name: 'D' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'alice', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        fitScore: 4,
        subreddit: 'rpg',
        targetUser: 'bob',
        body: 'hey bob, ...',
        reasoning: 'matched post',
        composeUrl: 'https://reddit.com/message/compose?to=bob&subject=hi',
        sourceRef: { permalink: '/r/rpg/p/1' },
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].state).toBe('pending_review');
    expect(drafts[0].targetUser).toBe('bob');
    expect(drafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
    // issue #325: the agent-supplied composeUrl above is never honoured -
    // drafts_create builds its own server-side from targetUser + body, so
    // it can never disagree with the reviewed body. `message=` decodes back
    // to exactly `body`.
    expect(drafts[0].composeUrl).not.toBe('https://reddit.com/message/compose?to=bob&subject=hi');
    const composeUrl = new URL(drafts[0].composeUrl!);
    expect(composeUrl.origin + composeUrl.pathname).toBe('https://www.reddit.com/message/compose');
    expect(composeUrl.searchParams.get('to')).toBe('bob');
    expect(composeUrl.searchParams.get('message')).toBe('hey bob, ...');
    // No qualityScore supplied - persists as null (not scored).
    expect(drafts[0].qualityScore).toBeNull();
    expect(drafts[0].qualityReason).toBeNull();
    expect(drafts[0].qualityModel).toBeNull();
  });

  it('enforces house style on the body through drafts:create (#572): mechanical repair applies, and a structural finding travels with the draft instead of being silently accepted', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'style-demo', name: 'D' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'alice', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        subreddit: 'rpg',
        targetUser: 'carol',
        // An em dash (character-level: mechanically repaired) plus a
        // rhetorical-question opener (structural: not mechanically
        // fixable, no live model on this path to send it back to).
        body: 'Ever wondered why builds are slow\u2014ours got faster this week?',
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.runId, run.id));
    // The em dash is gone, replaced with a comma, and nothing else changed.
    expect(draft.body).toBe('Ever wondered why builds are slow, ours got faster this week?');
    // The rhetorical-question opener could not be mechanically repaired and
    // has no live model to round-trip against here: it is shown, not
    // dropped.
    const metadata = draft.metadata as { styleFindings?: Array<{ ruleId: string }> };
    expect(metadata.styleFindings).toBeDefined();
    expect(metadata.styleFindings!.map((f) => f.ruleId)).toContain('rhetorical-question-opener');
    expect(metadata.styleFindings!.map((f) => f.ruleId)).not.toContain('em-dash');

    // LOR-224: the finding that survived to this post-hoc backstop is
    // recorded as a run event too, not just in the draft's own metadata -
    // that count is the measurement of whether a playbook's own in-run
    // check_style call is actually catching things before they get here.
    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id));
    const stylePayloads = events.map((e) => e.payload as { eventType?: string });
    const styleEventIndex = stylePayloads.findIndex(
      (p) => p.eventType === 'style-findings-at-create',
    );
    expect(styleEventIndex).toBeGreaterThanOrEqual(0);
    const eventPayload = JSON.parse(events[styleEventIndex].raw) as {
      runId: number;
      draftCount: number;
      findingsCount: number;
    };
    expect(eventPayload.runId).toBe(run.id);
    expect(eventPayload.draftCount).toBe(1);
    expect(eventPayload.findingsCount).toBe(1);
  });

  it('records a zero-findings run event when the draft is already clean (LOR-224)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'style-clean-demo', name: 'D' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'dana', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        subreddit: 'rpg',
        targetUser: 'erin',
        body: 'This is a plain, human sentence with nothing to flag.',
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id));
    const stylePayloads = events.map((e) => e.payload as { eventType?: string });
    const styleEventIndex = stylePayloads.findIndex(
      (p) => p.eventType === 'style-findings-at-create',
    );
    expect(styleEventIndex).toBeGreaterThanOrEqual(0);
    const eventPayload = JSON.parse(events[styleEventIndex].raw) as { findingsCount: number };
    expect(eventPayload.findingsCount).toBe(0);
  });

  it('ignores an inline qualityScore/qualityReason in the payload - scoring is computed server-side, never accepted from the caller (LOR-229)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo3', name: 'D3' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'carol', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c3',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'dave',
        body: 'hey dave, ...',
        sourceRef: {},
        metadata: {},
        qualityScore: 82,
        qualityReason: 'specific and personal',
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    // A clean, short body with no operator voice corpus in this fixture has
    // nothing for the deterministic scorer to measure - it reports "not
    // scored", never the 82/"specific and personal" the payload asked for.
    expect(drafts[0].qualityScore).toBeNull();
    expect(drafts[0].qualityReason).toBeNull();
    expect(drafts[0].qualityModel).toBeNull();
  });

  it('computes a deterministic quality score at creation, capped below green when the body carries a style finding (LOR-229)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo3b', name: 'D3b' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'erin', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c3b',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'frank',
        body: "In today's fast-paced world, it's worth noting the update shipped.",
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const res = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.accountId, account.id));
    expect(draft.qualityModel).toBe('deterministic');
    expect(draft.qualityScore).not.toBeNull();
    expect(draft.qualityScore).toBeLessThan(75);
  });

  it('carries sourceRef.sourceText through to persistence and populates the echo/language-match axes a source-less draft leaves null (LOR-251)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-lor251a', name: 'D251a' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'grace', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c251a',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const postText =
      'We just shipped the new expense reconciliation workflow after months of testing and everyone on the team is relieved it finally works end to end.';
    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        subreddit: 'smallbusiness',
        targetUser: 'opuser',
        // The "in today's fast-paced world" clause is a known style
        // finding, which caps the score at an integer regardless of the
        // axis average - this test is about the echo axis, not about
        // exercising every score value the deterministic scorer can reach.
        body: "In today's fast-paced world, congrats on shipping the new expense reconciliation workflow for the whole team.",
        sourceRef: { permalink: '/r/smallbusiness/comments/abc/x/', sourceText: postText },
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const res = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.accountId, account.id));
    expect((draft.sourceRef as Record<string, unknown>).sourceText).toBe(postText);
    const detail = (draft.metadata as Record<string, unknown>).qualityDetail as {
      deterministic: {
        sourceMeasured: boolean;
        languageMatch: boolean | null;
        distance: { echo: number | null; languageMatch: number | null };
      };
    };
    expect(detail.deterministic.sourceMeasured).toBe(true);
    expect(detail.deterministic.distance.echo).not.toBeNull();
    expect(detail.deterministic.distance.echo as number).toBeGreaterThan(0);
    expect(detail.deterministic.languageMatch).toBe(true);
    expect(detail.deterministic.distance.languageMatch).toBe(0);
  });

  it('reports the echo and language-match axes as not measurable, never a guessed zero, on a proactive post with no source (LOR-251)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-lor251b', name: 'D251b' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'henry', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c251b',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'smallbusiness',
        title: 'Launch day',
        // A known style finding ("in today's fast-paced world") so the score
        // is guaranteed non-null via the style cap regardless of corpus
        // state - the point of this test is the source axes, not the cap.
        body: "In today's fast-paced world, it's worth noting the update shipped.",
        sourceRef: { postAngle: 'launch' },
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const res = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.accountId, account.id));
    expect(draft.qualityScore).not.toBeNull();
    const detail = (draft.metadata as Record<string, unknown>).qualityDetail as {
      deterministic: {
        sourceMeasured: boolean;
        languageMatch: boolean | null;
        distance: { echo: number | null; languageMatch: number | null };
      };
    };
    expect(detail.deterministic.sourceMeasured).toBe(false);
    expect(detail.deterministic.distance.echo).toBeNull();
    expect(detail.deterministic.languageMatch).toBeNull();
    expect(detail.deterministic.distance.languageMatch).toBeNull();
  });

  // LOR-265: the finding that makes the pin more than a prompt tweak - a
  // campaign pinned to Italian that correctly answers an English post in
  // Italian must score a language *match*, not a manufactured mismatch
  // against the post it was explicitly asked to override. This fixture's
  // body is unambiguous Italian, so `classifyLanguage` alone already
  // picks the Italian phrase list here regardless of the pin - the next
  // test below (LOR-291) is the one that actually forces the pin to
  // matter, on a body the classifier alone cannot read.
  it('a campaign pinned to Italian scores a language match on an English post, and the style checker runs the Italian rule list (LOR-265)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-lor265', name: 'D265' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'giulia',
        role: 'personal',
      })
      .returning();
    // The pin lives on campaign.config.voice.language (LOR-265), the same
    // shared voice shape every drafting scenario's config already carries
    // tone/hardBans/dos/disclosure through.
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c265',
        skillSlug: 'reddit-commenter',
        config: { voice: { language: 'it' } },
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // The post is unambiguously English; the reply is unambiguously
    // Italian - the exact case the pin exists to protect - and opens with
    // an Italian-only filler-opener tell ("Ottimo punto") so the persisted
    // style findings can show which language's rule list actually fired.
    const postText =
      'We just shipped the new expense reconciliation workflow after months of testing and the whole team is relieved it finally works end to end.';
    const body =
      'Ottimo punto, avete fatto un gran lavoro con il nuovo flusso di riconciliazione delle spese dopo mesi di test e sono contento che funzioni bene.';
    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        subreddit: 'smallbusiness',
        targetUser: 'opuser',
        body,
        sourceRef: { permalink: '/r/smallbusiness/comments/xyz/y/', sourceText: postText },
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const res = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.accountId, account.id));

    // The style checker ran on the real, unedited Italian body and found
    // the Italian-list finding, not an English one - proof the rule list
    // it ran was the Italian one, decided by the body's own language, not
    // by the pin (style-check.ts is unmodified by this issue on purpose).
    const metadata = draft.metadata as {
      styleFindings?: Array<{ ruleId: string; message: string }>;
    };
    expect(metadata.styleFindings).toBeDefined();
    const fillerFinding = metadata.styleFindings!.find((f) => f.ruleId === 'filler-opener');
    expect(fillerFinding).toBeDefined();
    expect(fillerFinding!.message).toContain('(Italian)');

    // The quality axis: without the pin this would read `languageMatch:
    // false` (Italian body against an English post) - the pin makes it a
    // match, and `expectedLanguage`/`postLanguage` together show why.
    const detail = (draft.metadata as Record<string, unknown>).qualityDetail as {
      deterministic: {
        languageMatch: boolean | null;
        candidateLanguage: string;
        postLanguage: string | null;
        expectedLanguage: string | null;
        distance: { languageMatch: number | null };
      };
    };
    expect(detail.deterministic.candidateLanguage).toBe('it');
    expect(detail.deterministic.postLanguage).toBe('en');
    expect(detail.deterministic.expectedLanguage).toBe('it');
    expect(detail.deterministic.languageMatch).toBe(true);
    expect(detail.deterministic.distance.languageMatch).toBe(0);
  });

  // LOR-291: the case the test above cannot prove, because its body is
  // unambiguous Italian - `classifyLanguage` alone already picks the
  // Italian list there, pin or no pin. This body is deliberately the
  // shape LOR-280 measured as common and ambiguous: short, and it reads as
  // `unknown` to `classifyLanguage` on its own (confirmed below rather
  // than assumed). It also borrows a real English term ("leverage")
  // exactly the way it uses a real Italian one for the same idea
  // ("innovativa") - a realistic way for this exact ambiguity to occur.
  // Before this issue, an `unknown` verdict ran *both* phrase lists, so
  // "leverage" would ship as a second, spurious English-list finding
  // alongside the real Italian one. Pinned to Italian, the checker must
  // run the Italian list only.
  it('a campaign pinned to Italian runs only the Italian rule list on a body classifyLanguage alone reads as unknown (LOR-291)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-lor291', name: 'D291' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'marco',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c291',
        skillSlug: 'reddit-commenter',
        config: { voice: { language: 'it' } },
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const body = 'Innovativa soluzione qui, complimenti, leverage forte.';
    expect(classifyLanguage(body)).toBe('unknown');

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        subreddit: 'smallbusiness',
        targetUser: 'opuser',
        body,
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const res = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.accountId, account.id));

    const metadata = draft.metadata as {
      styleFindings?: Array<{ ruleId: string; message: string; span: string }>;
    };
    expect(metadata.styleFindings).toBeDefined();
    const puffery = metadata.styleFindings!.filter((f) => f.ruleId === 'puffery');
    // Exactly the Italian-list finding: the pin excludes the English list
    // outright, so "leverage" (a real English-list phrase too) never
    // ships as a second finding the way it would on an `unknown` verdict
    // with no pin to decide for it.
    expect(puffery).toHaveLength(1);
    expect(puffery[0]?.span).toBe('Innovativa');
    expect(puffery[0]?.message).toContain('(Italian)');
  });

  it('skips blocklisted targets and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo2', name: 'D2' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c2',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Insert blocklist entry for 'Bob' (mixed case) - should block 'bob' (lowercase) in the input
    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'user',
      value: 'Bob',
      scope: 'global',
      reason: 'asked-not-to-contact',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'alice',
        body: 'hey alice, ...',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'bob',
        body: 'hey bob, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].targetUser).toBe('bob');
    expect(res.data.skipped[0].reason).toBe('asked-not-to-contact');

    // Only alice's draft should be in the DB; no draft or draft_event for bob
    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetUser).toBe('alice');
    const events = await db.select().from(schema.draftEvents);
    expect(events).toHaveLength(1);
    expect(events[0].draftId).toBe(drafts[0].id);
  });

  it('skips a target already marked uncontactable, and reports it in the response (issue #335)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-uncontactable', name: 'DU' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender-u',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c-uncontactable',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // A prior draft to 'bob' already came back undeliverable (the extension
    // route this mirrors is web/tests/extension-undeliverable.test.ts).
    await db.insert(schema.contactHistory).values({
      platformId: platform.id,
      accountHandle: 'sender-u',
      targetUser: 'bob',
      organizationId: org.id,
      uncontactable: true,
      uncontactableReason: 'You are unable to send a message request to this account.',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'alice',
        body: 'hey alice, ...',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'bob',
        body: 'hey bob, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].targetUser).toBe('bob');
    expect(res.data.skipped[0].reason).toBe(
      'uncontactable: You are unable to send a message request to this account.',
    );

    // Only alice's draft exists - the loop actually closes: bob is never
    // offered again by the path that would have drafted for him.
    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetUser).toBe('alice');
  });

  it('does not skip a post/post_comment draft for an uncontactable DM target - the mark is DM-specific', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-uncontactable-comment', name: 'DUC' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender-uc',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c-uncontactable-comment',
        skillSlug: 'reddit-commenter',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    await db.insert(schema.contactHistory).values({
      platformId: platform.id,
      accountHandle: 'sender-uc',
      targetUser: 'carol',
      organizationId: org.id,
      uncontactable: true,
      uncontactableReason: 'You are unable to send a message request to this account.',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        targetUser: 'carol',
        subreddit: 'fixture',
        body: 'a public reply, not a DM',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    // Reddit cannot refuse a public reply the way it refuses a DM request -
    // the uncontactable mark from the DM path must not block the comment path.
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(0);
  });

  it('skips drafts targeting a blocklisted subreddit and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-sub', name: 'DemoSub' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender-sub',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c-sub',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'subreddit',
      value: 'CryptoCurrency',
      scope: 'global',
      reason: 'off-topic subreddit',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'rpg',
        body: 'a post about rpgs',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'cryptocurrency',
        body: 'a post about crypto',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].reason).toBe('off-topic subreddit');

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
  });

  it('skips drafts whose body or title contains a blocklisted keyword and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo-kw', name: 'DemoKw' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender-kw',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c-kw',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'keyword',
      value: 'giveaway',
      scope: 'global',
      reason: 'spammy keyword',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'rpg',
        title: 'A normal post',
        body: 'nothing special here',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'post',
        subreddit: 'rpg',
        title: 'Huge Giveaway inside!',
        body: 'come check it out',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].reason).toBe('spammy keyword');

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe('A normal post');
  });

  it('rejects a draft whose accountId belongs to a different project (issue #107)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);

    // Project A owns the campaign/run.
    const [projectA] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'proj-a', name: 'Project A' })
      .returning();
    const [accountA] = await db
      .insert(schema.accounts)
      .values({
        projectId: projectA.id,
        platformId: platform.id,
        handle: 'a-owner',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: projectA.id,
        platformId: platform.id,
        name: 'ca',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Project B owns a foreign account that should never be attributable to
    // project A's drafts.
    const [projectB] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'proj-b', name: 'Project B' })
      .returning();
    const [accountB] = await db
      .insert(schema.accounts)
      .values({
        projectId: projectB.id,
        platformId: platform.id,
        handle: 'b-owner',
        role: 'personal',
      })
      .returning();

    // Foreign accountId is rejected: the whole batch fails with a clear error
    // and nothing is persisted.
    const foreignPayload = JSON.stringify([
      {
        accountId: accountB.id,
        kind: 'dm',
        targetUser: 'eve',
        body: 'hey eve, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    let threw = false;
    try {
      cli(`drafts:create --run=${run.id}`, foreignPayload);
    } catch (err) {
      threw = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/account/i);
      expect(res.error).toMatch(new RegExp(String(accountB.id)));
    }
    expect(threw).toBe(true);

    const draftsAfterForeign = await db.select().from(schema.drafts);
    expect(draftsAfterForeign).toHaveLength(0);

    // Same-project accountId succeeds as before.
    const samePayload = JSON.stringify([
      {
        accountId: accountA.id,
        kind: 'dm',
        targetUser: 'frank',
        body: 'hey frank, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, samePayload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const draftsAfterSame = await db.select().from(schema.drafts);
    expect(draftsAfterSame).toHaveLength(1);
    expect(draftsAfterSame[0].accountId).toBe(accountA.id);
  });

  it('rejects Reddit post/post_comment drafts with no subreddit, accepts them with one, and leaves dm untouched (issue #258)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'sub-guard', name: 'Sub Guard' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'carol', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-commenter',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Reject: no subreddit anywhere on a post_comment draft. The whole batch
    // fails and nothing is persisted.
    const missingPayload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        targetUser: null,
        body: 'a comment about rpgs',
        sourceRef: {},
        metadata: {},
      },
    ]);

    let threw = false;
    try {
      cli(`drafts:create --run=${run.id}`, missingPayload);
    } catch (err) {
      threw = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/subreddit/i);
      expect(res.error).toMatch(/post_comment/);
    }
    expect(threw).toBe(true);
    expect(await db.select().from(schema.drafts)).toHaveLength(0);

    // Reject: same for a top-level "post" draft.
    const missingPostPayload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        targetUser: null,
        title: 'A post with nowhere to go',
        body: 'body text',
        sourceRef: {},
        metadata: {},
      },
    ]);
    let postThrew = false;
    try {
      cli(`drafts:create --run=${run.id}`, missingPostPayload);
    } catch (err) {
      postThrew = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/subreddit/i);
    }
    expect(postThrew).toBe(true);
    expect(await db.select().from(schema.drafts)).toHaveLength(0);

    // Accept: subreddit supplied via the top-level field (reddit-commenter.md's convention).
    const withTopLevelSubreddit = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post_comment',
        subreddit: 'rpg',
        targetUser: null,
        body: 'a comment about rpgs',
        sourceRef: {},
        metadata: {},
      },
    ]);
    const out1 = cli(`drafts:create --run=${run.id}`, withTopLevelSubreddit);
    const res1 = JSON.parse(out1.trim().split('\n').at(-1)!);
    expect(res1.ok).toBe(true);
    expect(res1.data.inserted).toBe(1);

    // Accept: subreddit supplied inline in metadata (reddit-poster.md's convention).
    const withMetadataSubreddit = JSON.stringify([
      {
        accountId: account.id,
        kind: 'post',
        targetUser: null,
        title: 'A post with somewhere to go',
        body: 'body text',
        sourceRef: {},
        metadata: { subreddit: 'cryptocurrency' },
      },
    ]);
    const out2 = cli(`drafts:create --run=${run.id}`, withMetadataSubreddit);
    const res2 = JSON.parse(out2.trim().split('\n').at(-1)!);
    expect(res2.ok).toBe(true);
    expect(res2.data.inserted).toBe(1);

    // Unaffected: dm drafts legitimately have no subreddit and are never
    // subject to this guard even on the Reddit platform.
    const dmPayload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'dave',
        body: 'hey dave, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);
    const out3 = cli(`drafts:create --run=${run.id}`, dmPayload);
    const res3 = JSON.parse(out3.trim().split('\n').at(-1)!);
    expect(res3.ok).toBe(true);
    expect(res3.data.inserted).toBe(1);

    const finalDrafts = await db.select().from(schema.drafts).orderBy(schema.drafts.id);
    expect(finalDrafts).toHaveLength(3);
    expect(finalDrafts[0].kind).toBe('post_comment');
    expect(finalDrafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
    expect(finalDrafts[1].kind).toBe('post');
    expect(finalDrafts[1].metadata).toMatchObject({ subreddit: 'cryptocurrency' });
    expect(finalDrafts[2].kind).toBe('dm');
    expect(finalDrafts[2].targetUser).toBe('dave');
  });
});

afterAll(async () => {
  await getPool().end();
});
