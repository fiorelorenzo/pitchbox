import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { recordVoiceSamples, setVoiceSampleExcluded } from '../src/operator-profile.js';
import {
  EMPTY_RHYTHM,
  EMPTY_EDIT_SIGNATURE,
  MIN_ITEMS_TO_DERIVE,
} from '../src/assist/voice-profile.js';
import { DEFAULT_VOICE_PROFILE } from '../src/assist/voice-defaults.js';
import {
  loadVoiceProfile,
  refreshVoiceProfile,
  saveVoiceProfileSummary,
  resetVoiceProfileToDerived,
  resolveOperatorVoiceProfile,
  setEditSignatureExcluded,
  VOICE_AXES,
  type VoiceProfileEvidence,
} from '../src/operator-voice-profile.js';

// #407: the operator's derived voice profile, end to end against a real
// corpus (voice samples, an outbound message, a sent draft, a template).
// What matters here is what the pure unit tests (assist-voice-profile.test.ts)
// cannot check on their own: the corpus is gathered org-scoped across four
// different tables, excluding a real voice sample row changes what gets
// derived, and a manual edit really does survive a real refresh.
//
// 2026-09-09 (#570/#571): the versioning and default-resolution tests below
// are the DB-round-trip half of that work - the pure logic (what "measured"
// vs "default" means, what a legacy row normalizes to) is already pinned in
// assist-voice-profile.test.ts and the pure resolveVoiceProfile tests here;
// what only a real database can prove is that a row actually written by an
// older shape reads back correctly, and that a real recompute against
// Postgres bumps the version rather than silently overwriting.

async function reset() {
  await getDb().execute(
    sql`TRUNCATE operator_voice_profiles, operator_voice_samples, operator_profiles,
      messages, contact_history, drafts, runs, campaigns, templates, accounts, projects
      RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function ensureOrg(slug: string): Promise<number> {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org!.id;
}

async function platformId(slug: string): Promise<number> {
  const [p] = await getDb().select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

/**
 * Builds one organization's whole corpus: two voice samples, one outbound
 * message, one sent draft and one template, all sharing "team" and with
 * "Just shipped" opening only the two voice samples - so excluding both
 * voice samples (and only them) is exactly what should make that opening
 * disappear from the derived profile.
 */
async function seedCorpus(orgId: number, tag: string) {
  const db = getDb();
  const linkedin = await platformId('linkedin');
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: `${tag}-proj`, name: `${tag} proj` })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: linkedin, handle: `${tag}-acct` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: linkedin, name: `${tag} c`, skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();

  await recordVoiceSamples(db, orgId, linkedin, [
    {
      externalId: `${tag}-sample-1`,
      text: 'Just shipped campaign search today, the team is thrilled with results this week.',
    },
    {
      externalId: `${tag}-sample-2`,
      text: 'Just shipped the new onboarding flow, our team worked hard to get it right this quarter.',
    },
  ]);

  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: linkedin,
      accountHandle: account.handle,
      targetUser: `${tag}-target`,
      organizationId: orgId,
    })
    .returning();
  await db.insert(schema.messages).values({
    contactId: contact.id,
    platformId: linkedin,
    author: account.handle,
    isFromUs: true,
    body: 'Wrapped up a big migration this week, the team should notice a real speed difference now.',
    platformMessageId: `${tag}-msg-1`,
    createdAtPlatform: new Date(),
    source: 'linkedin',
  });

  await db.insert(schema.drafts).values({
    runId: run.id,
    projectId: proj.id,
    platformId: linkedin,
    accountId: account.id,
    kind: 'post',
    state: 'sent',
    body: "Working through customer interviews all week, learned a lot about our team's priorities lately.",
    sentAt: new Date(),
    sentContent:
      "Working through customer interviews all week, learned a lot about our team's priorities lately.",
  });

  await db.insert(schema.templates).values({
    projectId: proj.id,
    kind: 'post',
    title: `${tag} template`,
    body: 'Excited to share our new pricing page, huge thanks to the whole team behind it.',
  });

  return { proj, account, campaign, run, linkedin };
}

// A real-looking corpus sized and worded to make a specific claim per axis
// (#570's acceptance: "the rich case produces measurements that actually
// differ from the defaults"). Verified by hand against `measureVoiceCorpus`
// directly before being written here: 12 items, 201 words, so it clears
// both `MIN_ITEMS_TO_DERIVE` and the lexicon's 200-word avoided-word floor.
// Eight English voice samples share a repeated emoji and hashtag and end on
// a claim; four Italian sent messages give the language split something
// real to report both overall and per corpus surface.
const RICH_ENGLISH_SAMPLES = [
  'Shipped the new onboarding flow today. It took three tries to get the copy exactly right. \u{1F680} #buildinpublic.',
  'Talked to five different customers this week. Every single one asked for the same export feature. \u{1F680} #buildinpublic.',
  'Fixed a nasty race condition in the background queue. Took two full days to track it down.',
  'Wrote the whole feature spec on a plane. No wifi, no distractions, just me and the document.',
  'I think the pricing page still confuses people. Probably needs another pass next sprint.',
  'Our whole team debated this for a week before deciding. We chose the simpler approach in the end.',
  'Reviewed every pull request myself this sprint. Small changes, merged fast, nothing sat waiting overnight.',
  'Wrote a short retro after the outage last night. Named exactly what broke and what changes next.',
];
const RICH_ITALIAN_MESSAGES = [
  'Abbiamo chiuso la migrazione questa mattina. Il team dovrebbe notare una vera differenza di velocita adesso.',
  'Il nostro piccolo team ha avuto un trimestre difficile. Ne abbiamo parlato apertamente e siamo andati avanti.',
  'Ho scritto tutta la specifica in aereo. Niente wifi, nessuna distrazione, solo io e il documento.',
  'Penso che la pagina dei prezzi confonda ancora le persone. Probabilmente serve un altro passaggio nel prossimo sprint.',
];

async function seedRichCorpus(orgId: number, tag: string) {
  const db = getDb();
  const linkedin = await platformId('linkedin');
  await recordVoiceSamples(
    db,
    orgId,
    linkedin,
    RICH_ENGLISH_SAMPLES.map((text, i) => ({ externalId: `${tag}-rich-sample-${i}`, text })),
  );

  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: `${tag}-rich-proj`, name: `${tag} rich proj` })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: linkedin, handle: `${tag}-rich-acct` })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: linkedin,
      accountHandle: account.handle,
      targetUser: `${tag}-rich-target`,
      organizationId: orgId,
    })
    .returning();
  for (const [i, body] of RICH_ITALIAN_MESSAGES.entries()) {
    await db.insert(schema.messages).values({
      contactId: contact.id,
      platformId: linkedin,
      author: account.handle,
      isFromUs: true,
      body,
      platformMessageId: `${tag}-rich-msg-${i}`,
      createdAtPlatform: new Date(),
      source: 'linkedin',
    });
  }
}

describe('shared/src/operator-voice-profile', () => {
  beforeEach(reset);

  it('returns null before anything has ever been derived', async () => {
    const orgId = await ensureOrg('vp-org-empty');
    expect(await loadVoiceProfile(getDb(), orgId)).toBeNull();
  });

  it('derives from voice samples, an outbound message, a sent draft and a template together', async () => {
    const orgId = await ensureOrg('vp-org-a');
    await seedCorpus(orgId, 'a');

    const row = await refreshVoiceProfile(getDb(), orgId);
    expect(row.source).toBe('derived');
    expect(row.derivedAt).not.toBeNull();
    expect(row.itemCount).toBe(5);
    expect(row.summary).toContain('Just shipped');
    expect(row.summary).toContain('team');
    expect(row.evidence.counts).toEqual({
      voiceSamples: 2,
      messages: 1,
      drafts: 1,
      templates: 1,
      acceptedSuggestions: 0,
    });
    expect(row.evidence.voiceSampleIds).toHaveLength(2);
    expect(row.evidence.messageIds).toHaveLength(1);
    expect(row.evidence.draftIds).toHaveLength(1);
    expect(row.evidence.templateIds).toHaveLength(1);
  });

  it('never crosses an organization boundary while gathering the corpus', async () => {
    const orgA = await ensureOrg('vp-org-scope-a');
    const orgB = await ensureOrg('vp-org-scope-b');
    await seedCorpus(orgA, 'sa');
    // Org B has only its own single voice sample - nowhere near enough on
    // its own to derive anything, which is exactly the point: if org A's
    // rows leaked in, this would suddenly be measurable.
    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgB, linkedin, [
      { externalId: 'sb-sample-1', text: 'Just a lone post over here, nothing to compare it to.' },
    ]);

    const rowB = await refreshVoiceProfile(getDb(), orgB);
    expect(rowB.itemCount).toBe(1);
    expect(rowB.summary).toBe('');
    expect(rowB.evidence.counts).toEqual({
      voiceSamples: 1,
      messages: 0,
      drafts: 0,
      templates: 0,
      acceptedSuggestions: 0,
    });
  });

  it('excluding the voice samples that carried a habit removes it from the derived profile', async () => {
    const orgId = await ensureOrg('vp-org-exclude');
    await seedCorpus(orgId, 'ex');

    const before = await refreshVoiceProfile(getDb(), orgId);
    expect(before.summary).toContain('Just shipped');

    const samples = await getDb()
      .select({ id: schema.operatorVoiceSamples.id })
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgId));
    expect(samples).toHaveLength(2);
    for (const s of samples) {
      await setVoiceSampleExcluded(getDb(), orgId, s.id, true);
    }

    const after = await refreshVoiceProfile(getDb(), orgId);
    expect(after.itemCount).toBe(3);
    expect(after.summary).not.toContain('Just shipped');
  });

  it('a refresh after a new capture arrives updates the derived profile', async () => {
    const orgId = await ensureOrg('vp-org-refresh');
    await seedCorpus(orgId, 'rf');
    const before = await refreshVoiceProfile(getDb(), orgId);
    expect(before.itemCount).toBe(5);

    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgId, linkedin, [
      {
        externalId: 'rf-sample-3',
        text: 'Just shipped a third thing this week, the team keeps shipping fast every single time.',
      },
    ]);

    const after = await refreshVoiceProfile(getDb(), orgId);
    expect(after.itemCount).toBe(6);
    expect(after.derivedAt!.getTime()).toBeGreaterThanOrEqual(before.derivedAt!.getTime());
  });

  it('a manual edit survives a later automatic refresh', async () => {
    const orgId = await ensureOrg('vp-org-manual');
    await seedCorpus(orgId, 'mn');
    await refreshVoiceProfile(getDb(), orgId);

    const manual = await saveVoiceProfileSummary(
      getDb(),
      orgId,
      'Dry, first person, one idea per post.',
    );
    expect(manual.source).toBe('manual');

    // A new sample arrives and the passive refresh path runs, exactly as it
    // would from the capture route - it must not touch the manual summary.
    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgId, linkedin, [
      {
        externalId: 'mn-sample-3',
        text: 'A brand new post that would otherwise change the derivation.',
      },
    ]);
    const afterRefresh = await refreshVoiceProfile(getDb(), orgId);
    expect(afterRefresh.source).toBe('manual');
    expect(afterRefresh.summary).toBe('Dry, first person, one idea per post.');
  });

  it('resetting to derived discards the manual edit and recomputes', async () => {
    const orgId = await ensureOrg('vp-org-reset');
    await seedCorpus(orgId, 'rs');
    const derived = await refreshVoiceProfile(getDb(), orgId);
    await saveVoiceProfileSummary(getDb(), orgId, 'A manual override nobody asked to keep.');

    const reset = await resetVoiceProfileToDerived(getDb(), orgId);
    expect(reset.source).toBe('derived');
    expect(reset.summary).toBe(derived.summary);
  });

  it('a recompute on an unchanged corpus reproduces identical measurements but bumps the version', async () => {
    const orgId = await ensureOrg('vp-org-version');
    await seedCorpus(orgId, 'vr');

    const first = await refreshVoiceProfile(getDb(), orgId);
    expect(first.evidence.version).toBe(1);

    const second = await refreshVoiceProfile(getDb(), orgId);
    expect(second.evidence.version).toBe(2);
    // The counter moved; the content it describes did not - determinism and
    // "a recompute is a new version" hold at the same time, not in tension.
    expect(second.summary).toBe(first.summary);
    expect(second.traits).toEqual(first.traits);
    expect(second.openings).toEqual(first.openings);
    expect(second.evidence.rhythm).toEqual(first.evidence.rhythm);
    expect(second.evidence.language).toEqual(first.evidence.language);

    const third = await refreshVoiceProfile(getDb(), orgId);
    expect(third.evidence.version).toBe(3);
  });

  it('reads a row written before #570 shipped without throwing, as version 0 with valid empty axes', async () => {
    const orgId = await ensureOrg('vp-org-legacy');
    // The exact shape `refreshVoiceProfile` wrote before this change: no
    // `version`, none of the six extended axes - just the corpus ids and
    // counts #407 already stored.
    const legacyEvidence = {
      voiceSampleIds: [1, 2],
      messageIds: [],
      draftIds: [],
      templateIds: [],
      counts: { voiceSamples: 2, messages: 0, drafts: 0, templates: 0 },
    };
    await getDb()
      .insert(schema.operatorVoiceProfiles)
      .values({
        organizationId: orgId,
        summary: 'Usually writes with first person, speaking as themselves.',
        traits: ['first-person'],
        openings: [],
        closings: [],
        commonWords: [],
        wordsPerSentence: 12,
        itemCount: 4,
        wordCount: 80,
        evidence: legacyEvidence,
        source: 'derived',
        derivedAt: new Date(),
      });

    const row = await loadVoiceProfile(getDb(), orgId);
    expect(row).not.toBeNull();
    expect(row!.evidence.version).toBe(0);
    expect(row!.evidence.voiceSampleIds).toEqual([1, 2]);
    expect(row!.evidence.rhythm).toEqual(EMPTY_RHYTHM);
    expect(row!.summary).toBe('Usually writes with first person, speaking as themselves.');

    // A recompute over a legacy row starts counting from its version, not
    // from zero every time - 0 is "never versioned", not "version zero of a
    // fresh count".
    const refreshed = await refreshVoiceProfile(getDb(), orgId);
    expect(refreshed.evidence.version).toBe(1);
  });

  it('reads a genres object written before LOR-227 added medianItemWords/itemWordsSpread as 0, never undefined', async () => {
    const orgId = await ensureOrg('vp-org-legacy-genres');
    // The exact per-genre shape refreshVoiceProfile wrote before LOR-227:
    // summary/itemCount/measurable only, no medianItemWords/itemWordsSpread,
    // and `reply` entirely absent (a row derived before every genre had ever
    // been seen would look like this too).
    const legacyEvidence = {
      voiceSampleIds: [],
      messageIds: [],
      draftIds: [],
      templateIds: [],
      counts: { voiceSamples: 8, messages: 0, drafts: 0, templates: 0 },
      version: 3,
      genres: {
        post: { summary: 'Usually writes long posts.', itemCount: 8, measurable: true },
        comment: { summary: null, itemCount: 1, measurable: false },
      },
    };
    await getDb().insert(schema.operatorVoiceProfiles).values({
      organizationId: orgId,
      summary: 'placeholder',
      itemCount: 8,
      wordCount: 100,
      evidence: legacyEvidence,
      source: 'derived',
      derivedAt: new Date(),
    });

    const row = await loadVoiceProfile(getDb(), orgId);
    expect(row).not.toBeNull();
    // Present in the stored blob, missing only the two new fields: read back
    // as 0, not undefined - the exact bug a `r.genres ?? EMPTY_GENRE_SUMMARIES`
    // simplification would reintroduce, since that line only guards a wholly
    // absent `genres`, not a stale per-genre shape inside one that is present.
    expect(row!.evidence.genres.post).toEqual({
      summary: 'Usually writes long posts.',
      itemCount: 8,
      measurable: true,
      medianItemWords: 0,
      itemWordsSpread: 0,
    });
    expect(row!.evidence.genres.comment.medianItemWords).toBe(0);
    expect(row!.evidence.genres.comment.itemWordsSpread).toBe(0);
    // Absent from the stored blob entirely - still a full, valid empty
    // summary rather than undefined.
    expect(row!.evidence.genres.reply).toEqual({
      summary: null,
      itemCount: 0,
      measurable: false,
      medianItemWords: 0,
      itemWordsSpread: 0,
    });
  });
});

describe('per-genre derivation (LOR-223)', () => {
  beforeEach(reset);

  it('derives a comment-genre description that differs from the post-genre one, on a corpus containing both', async () => {
    const orgId = await ensureOrg('vp-org-genres');
    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgId, linkedin, [
      {
        externalId: 'g-post-1',
        text: 'Shipped a brand new onboarding flow this week after months of customer interviews and design review.',
        genre: 'post',
      },
      {
        externalId: 'g-post-2',
        text: 'Just wrapped up a long migration project and the whole team is relieved it finally landed cleanly.',
        genre: 'post',
      },
      {
        externalId: 'g-post-3',
        text: 'Spent the week debugging a nasty race condition in the scheduler and finally found the root cause today.',
        genre: 'post',
      },
      {
        externalId: 'g-comment-1',
        text: 'Nice work',
        genre: 'comment',
        context: 'https://www.linkedin.com/feed/update/urn:li:activity:1',
      },
      {
        externalId: 'g-comment-2',
        text: 'Love this',
        genre: 'comment',
        context: 'https://www.linkedin.com/feed/update/urn:li:activity:2',
      },
      {
        externalId: 'g-comment-3',
        text: 'So true',
        genre: 'comment',
        context: 'https://www.linkedin.com/feed/update/urn:li:activity:3',
      },
    ]);

    const row = await refreshVoiceProfile(getDb(), orgId);
    expect(row.evidence.genres.post.measurable).toBe(true);
    expect(row.evidence.genres.comment.measurable).toBe(true);
    expect(row.evidence.genres.post.summary).not.toBeNull();
    expect(row.evidence.genres.comment.summary).not.toBeNull();
    expect(row.evidence.genres.post.summary).not.toBe(row.evidence.genres.comment.summary);
    expect(row.evidence.genres.post.summary).toMatch(/^Based on 3 of their own posts /);
    expect(row.evidence.genres.comment.summary).toMatch(/^Based on 3 of their own comments /);
    expect(row.evidence.genres.reply.measurable).toBe(false);
  });

  it('a genre with too few items stays unmeasurable even when the pooled corpus is measurable', async () => {
    const orgId = await ensureOrg('vp-org-genre-thin');
    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgId, linkedin, [
      {
        externalId: 'thin-post-1',
        text: 'Shipped a brand new onboarding flow this week after months of customer interviews and design review.',
        genre: 'post',
      },
      {
        externalId: 'thin-post-2',
        text: 'Just wrapped up a long migration project and the whole team is relieved it finally landed cleanly.',
        genre: 'post',
      },
      {
        externalId: 'thin-post-3',
        text: 'Spent the week debugging a nasty race condition in the scheduler and finally found the root cause today.',
        genre: 'post',
      },
      { externalId: 'thin-comment-1', text: 'Nice work', genre: 'comment' },
    ]);

    const row = await refreshVoiceProfile(getDb(), orgId);
    expect(row.itemCount).toBe(4);
    expect(row.evidence.genres.post.measurable).toBe(true);
    expect(row.evidence.genres.comment.measurable).toBe(false);
    expect(row.evidence.genres.comment.summary).toBeNull();
    expect(row.evidence.genres.comment.itemCount).toBe(1);
  });

  it('a passive capture with no genre specified defaults to post/capture with no context', async () => {
    const orgId = await ensureOrg('vp-org-genre-defaults');
    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgId, linkedin, [
      { externalId: 'default-1', text: 'A plain captured post with no genre specified at all.' },
    ]);
    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].genre).toBe('post');
    expect(rows[0].source).toBe('capture');
    expect(rows[0].context).toBeNull();
  });
});

describe('resolveOperatorVoiceProfile', () => {
  beforeEach(reset);

  it('a thin or absent corpus resolves to the labelled defaults, never an invented profile', async () => {
    const orgId = await ensureOrg('vp-org-resolve-thin');

    const beforeAnyDerivation = await resolveOperatorVoiceProfile(getDb(), orgId);
    expect(beforeAnyDerivation.status).toBe('default');
    expect(beforeAnyDerivation.summary).toBe(DEFAULT_VOICE_PROFILE.summary);
    for (const axis of VOICE_AXES) expect(beforeAnyDerivation.axes[axis]).toBe('default');
    expect(beforeAnyDerivation.measured).toBeNull();
    expect(beforeAnyDerivation.gap).toMatch(/more pieces? of their own writing/);

    // Below MIN_ITEMS_TO_DERIVE even after a real derivation ran.
    const linkedin = await platformId('linkedin');
    await recordVoiceSamples(getDb(), orgId, linkedin, [
      { externalId: 'thin-1', text: 'Just one lone post here, nothing to compare it to yet.' },
    ]);
    await refreshVoiceProfile(getDb(), orgId);
    const stillThin = await resolveOperatorVoiceProfile(getDb(), orgId);
    expect(stillThin.itemCount).toBeLessThan(MIN_ITEMS_TO_DERIVE);
    expect(stillThin.status).toBe('default');
    expect(stillThin.axes.rhythm).toBe('default');
  });

  it('a rich, real-looking corpus resolves to measurements that actually differ from the defaults', async () => {
    const orgId = await ensureOrg('vp-org-resolve-rich');
    await seedRichCorpus(orgId, 'rr');
    await refreshVoiceProfile(getDb(), orgId);

    const resolved = await resolveOperatorVoiceProfile(getDb(), orgId);
    expect(resolved.status).toBe('measured');
    for (const axis of VOICE_AXES) expect(resolved.axes[axis]).toBe('measured');
    expect(resolved.gap).toBeNull();
    expect(resolved.summary).not.toBe(DEFAULT_VOICE_PROFILE.summary);

    const evidence = resolved.measured!.evidence as VoiceProfileEvidence;
    // Real content, not the defaults' placeholder rules: an emoji and a
    // hashtag genuinely reused across the fixture, a claim-dominant ending,
    // a mixed language split overall and a clean split per corpus surface,
    // and every default-sounding candidate word the fixture never used.
    expect(evidence.shape.emoji).toContain('\u{1F680}');
    expect(evidence.shape.hashtags).toContain('#buildinpublic');
    expect(evidence.shape.ending).toBe('claim');
    expect(evidence.language.primary).toBe('mixed');
    expect(evidence.language.byKind.voice_sample?.primary).toBe('en');
    expect(evidence.language.byKind.message?.primary).toBe('it');
    // None of the candidate words appear anywhere in the fixture, so the
    // corpus genuinely avoided all of them - a real absence, not a partial
    // or invented list.
    expect(evidence.lexicon.avoidedWords).toContain('leverage');
    expect(evidence.lexicon.avoidedWords).toContain('humbled');
    expect(evidence.lexicon.avoidedWords.length).toBeGreaterThanOrEqual(10);
    expect(evidence.rhythm.medianSentenceWords).toBeGreaterThan(0);
  });
});

/** A row in the assist plane's own ledger (`assist_accepted_suggestions`) -
 * what accepting a suggestion writes. `kind` is a DraftKind ('post' or
 * 'post_comment' today); `editedFrom` is the model's own draft, present
 * only when the human changed it before posting. */
async function makeAcceptedSuggestion(opts: {
  organizationId: number;
  kind: 'post' | 'post_comment';
  body: string;
  editedFrom?: string | null;
}) {
  const db = getDb();
  await db.insert(schema.assistAcceptedSuggestions).values({
    organizationId: opts.organizationId,
    platformId: await platformId('linkedin'),
    kind: opts.kind,
    body: opts.body,
    editedFrom: opts.editedFrom ?? null,
    agentRunner: 'claude-code',
  });
}

describe('accepted suggestions and the edit signature (LOR-227)', () => {
  beforeEach(reset);

  it('maps an accepted suggestion kind onto the corpus genre vocabulary (post_comment -> comment, post -> post)', async () => {
    const orgId = await ensureOrg('vp-org-accepted-genre');
    // Three of each kind - enough to clear MIN_ITEMS_TO_DERIVE per genre on
    // their own, with nothing else in the corpus to attribute the genre
    // measurement to.
    for (let i = 0; i < 3; i += 1) {
      await makeAcceptedSuggestion({
        organizationId: orgId,
        kind: 'post',
        body: `A real published post about shipping something new today, part ${i}.`,
      });
      await makeAcceptedSuggestion({
        organizationId: orgId,
        kind: 'post_comment',
        body: `Nice work ${i}!`,
      });
    }

    const row = await refreshVoiceProfile(getDb(), orgId);
    expect(row.evidence.counts.acceptedSuggestions).toBe(6);
    expect(row.evidence.genres.post.itemCount).toBe(3);
    expect(row.evidence.genres.post.measurable).toBe(true);
    expect(row.evidence.genres.comment.itemCount).toBe(3);
    expect(row.evidence.genres.comment.measurable).toBe(true);
  });

  it('a corpus with accepted suggestions produces a different profile than the same corpus without them', async () => {
    const withoutOrg = await ensureOrg('vp-org-no-accepted');
    const withOrg = await ensureOrg('vp-org-with-accepted');
    const baseSamples = [
      'Shipped a small fix today for the retry queue, seemed to help under load quite a bit honestly.',
      'Working through a backlog of bug reports this week, slow going but steady real progress overall.',
      'Put out a new release last night after testing thoroughly across every environment we support today.',
    ];
    const linkedin = await platformId('linkedin');
    for (const org of [withoutOrg, withOrg]) {
      for (const [i, text] of baseSamples.entries()) {
        await recordVoiceSamples(getDb(), org, linkedin, [
          { externalId: `sample-${org}-${i}`, text, postedAt: new Date().toISOString() },
        ]);
      }
    }
    // Only the second org gets accepted suggestions - three published posts
    // sharing a phrase reused often enough to be counted as recurring.
    for (let i = 0; i < 3; i += 1) {
      await makeAcceptedSuggestion({
        organizationId: withOrg,
        kind: 'post',
        body: `Big news: we just launched a redesign of the whole dashboard, part ${i} of the rollout today.`,
      });
    }

    const without = await refreshVoiceProfile(getDb(), withoutOrg);
    const withAccepted = await refreshVoiceProfile(getDb(), withOrg);
    expect(without.evidence.counts.acceptedSuggestions).toBe(0);
    expect(withAccepted.evidence.counts.acceptedSuggestions).toBe(3);
    expect(withAccepted.itemCount).toBeGreaterThan(without.itemCount);
    expect(withAccepted.wordCount).not.toBe(without.wordCount);
    expect(withAccepted.openings).not.toEqual(without.openings);
  });

  it('derives an edit signature from edited accepted suggestions, and stores it separately from the measured axes', async () => {
    const orgId = await ensureOrg('vp-org-edit-signature');
    await makeAcceptedSuggestion({
      organizationId: orgId,
      kind: 'post',
      body: 'Cool, thanks for sharing.',
      editedFrom:
        'Great question! I think this is really cool, thanks so much for sharing this with everyone.',
    });
    await makeAcceptedSuggestion({
      organizationId: orgId,
      kind: 'post',
      body: 'This resonates with me.',
      editedFrom:
        'Great question! I appreciate you writing this, it truly resonates with me a lot.',
    });
    await makeAcceptedSuggestion({
      organizationId: orgId,
      kind: 'post',
      body: 'Nice post.',
      editedFrom:
        'Nice post here, I think this is fantastic and I love reading things like this honestly.',
    });

    const row = await refreshVoiceProfile(getDb(), orgId);
    expect(row.evidence.editSignature.measurable).toBe(true);
    expect(row.evidence.editSignature.pairCount).toBe(3);
    expect(row.evidence.editSignature.bannedPhrases).toEqual(['Great question!']);
    expect(row.evidence.editSignature.shortensText).toBe(true);
    expect(row.evidence.editSignatureExcluded).toBe(false);
  });

  it('setEditSignatureExcluded persists across a later refresh, unlike the measured signature itself', async () => {
    const orgId = await ensureOrg('vp-org-edit-exclude');
    for (const [body, editedFrom] of [
      ['Cool, thanks for sharing.', 'Great question! Cool, thanks so much for sharing this.'],
      ['This resonates with me.', 'Great question! This truly resonates with me a lot.'],
      ['Nice post.', 'Great question! Nice post, I really loved reading this today.'],
    ] as const) {
      await makeAcceptedSuggestion({ organizationId: orgId, kind: 'post', body, editedFrom });
    }
    const derived = await refreshVoiceProfile(getDb(), orgId);
    expect(derived.evidence.editSignatureExcluded).toBe(false);
    expect(derived.evidence.editSignature.measurable).toBe(true);

    const excluded = await setEditSignatureExcluded(getDb(), orgId, true);
    expect(excluded.evidence.editSignatureExcluded).toBe(true);
    // The measured signature itself is untouched by the exclude toggle.
    expect(excluded.evidence.editSignature).toEqual(derived.evidence.editSignature);

    // A later refresh recomputes the signature but carries the exclusion
    // forward - it is a human judgement, not a measurement to overwrite.
    const refreshedAgain = await refreshVoiceProfile(getDb(), orgId, { overwrite: true });
    expect(refreshedAgain.evidence.editSignatureExcluded).toBe(true);
    expect(refreshedAgain.evidence.editSignature.measurable).toBe(true);
  });

  it('resolveOperatorVoiceProfile exposes the edit signature and its exclude flag', async () => {
    const orgId = await ensureOrg('vp-org-resolve-edit-signature');
    const resolvedBefore = await resolveOperatorVoiceProfile(getDb(), orgId);
    expect(resolvedBefore.editSignature).toEqual(EMPTY_EDIT_SIGNATURE);
    expect(resolvedBefore.editSignatureExcluded).toBe(false);

    for (const [body, editedFrom] of [
      ['Cool, thanks for sharing.', 'Great question! Cool, thanks so much for sharing this.'],
      ['This resonates with me.', 'Great question! This truly resonates with me a lot.'],
      ['Nice post.', 'Great question! Nice post, I really loved reading this today.'],
    ] as const) {
      await makeAcceptedSuggestion({ organizationId: orgId, kind: 'post', body, editedFrom });
    }
    await refreshVoiceProfile(getDb(), orgId);
    const resolvedAfter = await resolveOperatorVoiceProfile(getDb(), orgId);
    expect(resolvedAfter.editSignature.measurable).toBe(true);
    expect(resolvedAfter.editSignature.bannedPhrases).toEqual(['Great question!']);
  });
});
