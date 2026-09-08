import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { recordVoiceSamples, setVoiceSampleExcluded } from '../src/operator-profile.js';
import {
  loadVoiceProfile,
  refreshVoiceProfile,
  saveVoiceProfileSummary,
  resetVoiceProfileToDerived,
} from '../src/operator-voice-profile.js';

// #407: the operator's derived voice profile, end to end against a real
// corpus (voice samples, an outbound message, a sent draft, a template).
// What matters here is what the pure unit tests (assist-voice-profile.test.ts)
// cannot check on their own: the corpus is gathered org-scoped across four
// different tables, excluding a real voice sample row changes what gets
// derived, and a manual edit really does survive a real refresh.

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
    expect(row.evidence.counts).toEqual({ voiceSamples: 2, messages: 1, drafts: 1, templates: 1 });
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
    expect(rowB.evidence.counts).toEqual({ voiceSamples: 1, messages: 0, drafts: 0, templates: 0 });
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
});
