import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  loadOperatorProfile,
  saveOperatorProfile,
  listVoiceSamples,
  setVoiceSampleExcluded,
  recordVoiceSamples,
  importVoiceSamples,
} from '../src/operator-profile.js';

async function platformId(slug: string): Promise<number> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
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

describe('shared/src/operator-profile', () => {
  let linkedinId: number;
  let orgAId: number;
  let orgBId: number;

  beforeEach(async () => {
    await getDb().execute(
      sql`TRUNCATE operator_profiles, operator_voice_samples, accounts, projects RESTART IDENTITY CASCADE`,
    );
    await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
    linkedinId = await platformId('linkedin');
    orgAId = await ensureOrg('op-profile-org-a');
    orgBId = await ensureOrg('op-profile-org-b');
  });

  describe('loadOperatorProfile / saveOperatorProfile', () => {
    it('returns null when no row exists yet', async () => {
      expect(await loadOperatorProfile(getDb(), orgAId)).toBeNull();
    });

    it('a first capture inserts a row, defaults source to linkedin_capture, and sets capturedAt', async () => {
      const row = await saveOperatorProfile(getDb(), orgAId, {
        handle: 'ada-lovelace',
        displayName: 'Ada Lovelace',
      });
      expect(row.handle).toBe('ada-lovelace');
      expect(row.source).toBe('linkedin_capture');
      expect(row.capturedAt).not.toBeNull();
      expect(row.experiences).toEqual([]);
    });

    it('a later capture updates only the fields it carries, leaving the rest as they were', async () => {
      await saveOperatorProfile(getDb(), orgAId, {
        handle: 'ada-lovelace',
        displayName: 'Ada Lovelace',
        headline: 'Mathematician',
      });
      const row = await saveOperatorProfile(getDb(), orgAId, {
        headline: 'Mathematician and writer',
      });
      expect(row.displayName).toBe('Ada Lovelace');
      expect(row.headline).toBe('Mathematician and writer');
    });

    it('protects a manual row from an automated capture unless overwrite is set', async () => {
      await saveOperatorProfile(getDb(), orgAId, {
        handle: 'ada-lovelace',
        displayName: 'Ada, by hand',
        source: 'manual',
      });

      const skipped = await saveOperatorProfile(getDb(), orgAId, {
        displayName: 'Ada, from a capture',
        source: 'linkedin_capture',
      });
      expect(skipped.displayName).toBe('Ada, by hand');
      expect(skipped.source).toBe('manual');

      const overwritten = await saveOperatorProfile(
        getDb(),
        orgAId,
        { displayName: 'Ada, from a capture', source: 'linkedin_capture' },
        { overwrite: true },
      );
      expect(overwritten.displayName).toBe('Ada, from a capture');
      expect(overwritten.source).toBe('linkedin_capture');
    });

    it('always applies a manual-to-manual save, with no overwrite flag needed', async () => {
      await saveOperatorProfile(getDb(), orgAId, {
        handle: 'ada-lovelace',
        displayName: 'First manual edit',
        source: 'manual',
      });
      const row = await saveOperatorProfile(getDb(), orgAId, {
        displayName: 'Second manual edit',
        source: 'manual',
      });
      expect(row.displayName).toBe('Second manual edit');
    });
  });

  describe('listVoiceSamples / setVoiceSampleExcluded', () => {
    it('recordVoiceSamples dedupes on (organization_id, external_id) and reports only newly inserted rows', async () => {
      const firstBatch = await recordVoiceSamples(getDb(), orgAId, linkedinId, [
        { externalId: 'urn:li:activity:1', text: 'First post' },
        { externalId: 'urn:li:activity:2', text: 'Second post' },
      ]);
      expect(firstBatch).toBe(2);

      const secondBatch = await recordVoiceSamples(getDb(), orgAId, linkedinId, [
        { externalId: 'urn:li:activity:2', text: 'Second post, re-scraped' },
        { externalId: 'urn:li:activity:3', text: 'Third post' },
      ]);
      expect(secondBatch).toBe(1);

      const samples = await listVoiceSamples(getDb(), orgAId);
      expect(samples).toHaveLength(3);
      // Not resurrected/mutated by the duplicate in the second batch.
      expect(samples.find((s) => s.externalId === 'urn:li:activity:2')?.text).toBe('Second post');
    });

    it('setVoiceSampleExcluded flips the flag without deleting the row, and listVoiceSamples still returns it', async () => {
      await recordVoiceSamples(getDb(), orgAId, linkedinId, [
        { externalId: 'urn:li:activity:1', text: 'First post' },
      ]);
      const [sample] = await listVoiceSamples(getDb(), orgAId);
      await setVoiceSampleExcluded(getDb(), orgAId, sample.id, true);

      const after = await listVoiceSamples(getDb(), orgAId);
      expect(after).toHaveLength(1);
      expect(after[0].excluded).toBe(true);
    });

    it("never crosses an organization boundary: excluding org B's sample id under org A is a no-op", async () => {
      await recordVoiceSamples(getDb(), orgBId, linkedinId, [
        { externalId: 'urn:li:activity:cross', text: 'Org B post' },
      ]);
      const [sampleB] = await listVoiceSamples(getDb(), orgBId);

      await setVoiceSampleExcluded(getDb(), orgAId, sampleB.id, true);

      const stillB = await listVoiceSamples(getDb(), orgBId);
      expect(stillB[0].excluded).toBe(false);
    });
  });

  describe('genre/source (LOR-223)', () => {
    it('recordVoiceSamples defaults to genre post and source capture when neither is given', async () => {
      await recordVoiceSamples(getDb(), orgAId, linkedinId, [
        { externalId: 'urn:li:activity:default-genre', text: 'A plain captured post.' },
      ]);
      const [sample] = await listVoiceSamples(getDb(), orgAId);
      expect(sample.genre).toBe('post');
      expect(sample.source).toBe('capture');
      expect(sample.context).toBeNull();
    });

    it('recordVoiceSamples honors an explicit genre, source and context', async () => {
      await recordVoiceSamples(getDb(), orgAId, linkedinId, [
        {
          externalId: 'urn:li:activity:explicit',
          text: 'Nice work',
          genre: 'comment',
          source: 'manual',
          context: 'https://www.linkedin.com/feed/update/urn:li:activity:stimulus',
        },
      ]);
      const [sample] = await listVoiceSamples(getDb(), orgAId);
      expect(sample.genre).toBe('comment');
      expect(sample.source).toBe('manual');
      expect(sample.context).toBe('https://www.linkedin.com/feed/update/urn:li:activity:stimulus');
    });
  });

  describe('importVoiceSamples', () => {
    it('inserts every item tagged source import, and reports how many landed per genre', async () => {
      const result = await importVoiceSamples(getDb(), orgAId, linkedinId, [
        {
          externalId: 'li-import-post:1',
          genre: 'post',
          text: 'Shipped the importer today.',
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:import-1',
          postedAt: null,
          context: null,
        },
        {
          externalId: 'li-import-comment:1',
          genre: 'comment',
          text: 'Nice work',
          url: null,
          postedAt: null,
          context: 'https://www.linkedin.com/feed/update/urn:li:activity:import-1',
        },
      ]);
      expect(result).toEqual({ inserted: 2, byGenre: { post: 1, comment: 1 } });

      const samples = await listVoiceSamples(getDb(), orgAId);
      expect(samples).toHaveLength(2);
      expect(samples.every((s) => s.source === 'import')).toBe(true);
      const comment = samples.find((s) => s.genre === 'comment');
      expect(comment?.context).toBe(
        'https://www.linkedin.com/feed/update/urn:li:activity:import-1',
      );
    });

    it('dedupes on (organization_id, external_id) the same way recordVoiceSamples does - a re-import is a no-op', async () => {
      const item = {
        externalId: 'li-import-post:dup',
        genre: 'post' as const,
        text: 'Shipped the importer today.',
        url: null,
        postedAt: null,
        context: null,
      };
      const first = await importVoiceSamples(getDb(), orgAId, linkedinId, [item]);
      expect(first.inserted).toBe(1);
      const second = await importVoiceSamples(getDb(), orgAId, linkedinId, [item]);
      expect(second.inserted).toBe(0);

      const samples = await listVoiceSamples(getDb(), orgAId);
      expect(samples).toHaveLength(1);
    });

    it('returns zero for an empty batch without touching the database', async () => {
      const result = await importVoiceSamples(getDb(), orgAId, linkedinId, []);
      expect(result).toEqual({ inserted: 0, byGenre: { post: 0, comment: 0 } });
    });
  });

  // #521 removed ensureOperatorAccount as dead code once its only caller,
  // the accept path's per-account no_account gate, was itself removed - the
  // assist plane binds to the operator profile and the connected account
  // directly now, never a synthesized "personal" account row. This test
  // exercised a function that no longer exists, not a contract any caller
  // still relies on, so it is deleted rather than aimed at new internals.
});
