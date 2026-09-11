import { describe, it, expect } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { loadCompanionContext } from '../src/assist/context.js';

// LOR-233: `buildSuggestionPrompt` needs the operator's own comment-genre
// median word count as a number, not only as a sentence buried inside
// `commentSummary`'s prose. This is the wiring test for that one field -
// `loadCompanionContext` reading `evidence.genres.comment.medianItemWords`
// (LOR-227's own addition to `VoiceGenreSummary`) off a real row and
// mapping its `0` (not yet measurable) to `null` rather than forwarding a
// number nothing actually derived.
//
// The pure "which source wins, what the prompt says" behavior lives in
// `suggest-prompt.test.ts`; this only owns the DB-to-type mapping, which
// the pure tests cannot exercise since they never touch `loadVoiceProfile`.

async function reset() {
  // Scoped, not a blanket TRUNCATE of organizations (LOR-282): this file's
  // own tests only ever touch scratch orgs it creates itself
  // (ensureOrg('lor233-...')), never the seeded `slug = 'default'` row that
  // most of the suite falls back to. Truncating `organizations` wholesale
  // deleted that row for the rest of the run, with nothing to recreate it.
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`TRUNCATE operator_voice_profiles RESTART IDENTITY CASCADE`);
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

describe('loadCompanionContext: medianCommentWords (LOR-233)', () => {
  it("reads the comment genre's own median off evidence, not the pooled rhythm", async () => {
    await reset();
    const orgId = await ensureOrg('lor233-median');
    await getDb()
      .insert(schema.operatorVoiceProfiles)
      .values({
        organizationId: orgId,
        summary: 'Based on 12 pieces of their own writing (900 words). Often uses hashtags.',
        evidence: {
          genres: {
            comment: {
              summary:
                'Based on 27 of their own comments (190 words). A typical one runs about 7 words.',
              itemCount: 27,
              measurable: true,
              medianItemWords: 7,
              itemWordsSpread: 4,
            },
          },
        },
      });

    const context = await loadCompanionContext(getDb(), { organizationId: orgId });
    expect(context.voiceProfile?.commentSummary).toMatch(/about 7 words/);
    expect(context.voiceProfile?.medianCommentWords).toBe(7);
  });

  it('reports null, never 0, when the comment genre has not cleared the floor to derive one', async () => {
    await reset();
    const orgId = await ensureOrg('lor233-unmeasurable');
    await getDb()
      .insert(schema.operatorVoiceProfiles)
      .values({
        organizationId: orgId,
        summary: 'Based on 12 pieces of their own writing (900 words). Often uses hashtags.',
        evidence: {
          genres: {
            comment: {
              summary: null,
              itemCount: 1,
              measurable: false,
              medianItemWords: 0,
              itemWordsSpread: 0,
            },
          },
        },
      });

    const context = await loadCompanionContext(getDb(), { organizationId: orgId });
    expect(context.voiceProfile?.commentSummary).toBeNull();
    expect(context.voiceProfile?.medianCommentWords).toBeNull();
  });
});
