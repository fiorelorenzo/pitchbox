import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  ingestObservedTargets,
  MAX_OBSERVED_TARGETS_BATCH,
  type RawObservedTarget,
} from '../src/observed-targets.js';

async function platformId(slug: string): Promise<number> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

// Resolves an org by slug, creating it on first use - mirrors
// contact-dedup.test.ts's ensureOrg so a second tenant is available for the
// cross-org isolation test.
async function ensureOrg(slug: string): Promise<number> {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org!.id;
}

async function makeProject(organizationId: number, slug: string): Promise<number> {
  const db = getDb();
  const [p] = await db
    .insert(schema.projects)
    .values({ organizationId, slug, name: slug })
    .returning({ id: schema.projects.id });
  return p.id;
}

function observation(overrides: Partial<RawObservedTarget> = {}): RawObservedTarget {
  return {
    externalId: 'urn:li:activity:1111',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:1111/',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    text: 'A post about outreach automation.',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ingestObservedTargets', () => {
  let linkedinId: number;
  let orgAId: number;
  let orgBId: number;
  let projectAId: number;
  let projectBId: number;

  beforeEach(async () => {
    await getDb().execute(
      sql`TRUNCATE observed_targets, projects, organizations RESTART IDENTITY CASCADE`,
    );
    linkedinId = await platformId('linkedin');
    orgAId = await ensureOrg('obs-targets-org-a');
    orgBId = await ensureOrg('obs-targets-org-b');
    projectAId = await makeProject(orgAId, 'obs-targets-proj-a');
    projectBId = await makeProject(orgBId, 'obs-targets-proj-b');
  });

  it('repeat observation of the same post leaves exactly one row (row set, not an attempt count)', async () => {
    const db = getDb();
    const input = {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
    };

    const first = await ingestObservedTargets(db, { ...input, observations: [observation()] });
    expect(first.written).toHaveLength(1);
    expect(first.rejected).toBe(0);

    // A second sighting of the same post (a different debounce tick) must be
    // a no-op, not a second row - even though the shape differs slightly
    // (author/text can legitimately vary between reads of the same post).
    const second = await ingestObservedTargets(db, {
      ...input,
      observations: [observation({ authorName: 'Jane D.', text: 'slightly different snapshot' })],
    });
    expect(second.written).toHaveLength(0);
    expect(second.rejected).toBe(0);

    const rows = await db
      .select({ id: schema.observedTargets.id, externalId: schema.observedTargets.externalId })
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.organizationId, orgAId));
    // Assert the row set itself, not a count of ingest attempts.
    expect(rows.map((r) => r.externalId)).toEqual(['urn:li:activity:1111']);
    expect(rows).toHaveLength(1);
  });

  it('dedupes duplicates within a single batch against each other, not just against existing rows', async () => {
    const db = getDb();
    const result = await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [observation(), observation({ text: 'same post, seen twice in one tick' })],
    });
    expect(result.written).toHaveLength(1);
    expect(result.rejected).toBe(0);

    const rows = await db.select().from(schema.observedTargets);
    expect(rows).toHaveLength(1);
  });

  it('does not resurrect a row already consumed by a run', async () => {
    const db = getDb();
    await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [observation()],
    });

    // Simulate #304's drain marking the row consumed.
    const [run] = await db
      .insert(schema.runs)
      .values({ projectId: projectAId, trigger: 'manual', kind: 'project_extraction' })
      .returning({ id: schema.runs.id });
    await db
      .update(schema.observedTargets)
      .set({ consumedByRunId: run.id })
      .where(eq(schema.observedTargets.organizationId, orgAId));

    const repeat = await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [observation({ text: 'scrolled past it again after it was consumed' })],
    });
    expect(repeat.written).toHaveLength(0);

    const rows = await db.select().from(schema.observedTargets);
    expect(rows).toHaveLength(1);
    // Still consumed - the repeat sighting did not clear it back to fresh.
    expect(rows[0].consumedByRunId).toBe(run.id);
  });

  it('an observation ingested for org A is invisible to org B', async () => {
    const db = getDb();
    // Same public post, sighted by two different tenants' browsers - each
    // must get its own row, not a cross-tenant dedup collision.
    await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [observation()],
    });
    await ingestObservedTargets(db, {
      organizationId: orgBId,
      projectId: projectBId,
      platformId: linkedinId,
      observations: [observation()],
    });

    const rows = await db.select().from(schema.observedTargets);
    expect(rows).toHaveLength(2);

    const forOrgB = await db
      .select()
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.organizationId, orgBId));
    expect(forOrgB).toHaveLength(1);
    expect(forOrgB.every((r) => r.organizationId === orgBId)).toBe(true);
    // Org A's row never appears in an org-B-scoped read.
    expect(forOrgB.some((r) => r.organizationId === orgAId)).toBe(false);
  });

  it('drops a malformed entry without failing the rest of the batch', async () => {
    const db = getDb();
    const result = await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [
        observation({
          externalId: 'urn:li:activity:2222',
          url: 'https://linkedin.com/feed/update/urn:li:activity:2222/',
        }),
        // Malformed: no external_id at all (a feed sighting with no stable
        // identifier - the design's "must not create an observed_targets
        // row" case).
        { url: 'https://linkedin.com/feed/', observedAt: new Date().toISOString() },
      ],
    });

    expect(result.rejected).toBe(1);
    expect(result.written).toHaveLength(1);
    expect(result.written[0].externalId).toBe('urn:li:activity:2222');

    const rows = await db.select().from(schema.observedTargets);
    expect(rows.map((r) => r.externalId)).toEqual(['urn:li:activity:2222']);
  });

  it('rejects an entry with an unparsable observed_at or a non-URL url', async () => {
    const db = getDb();
    const result = await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [
        observation({ externalId: 'urn:li:activity:bad-date', observedAt: 'not-a-date' }),
        observation({ externalId: 'urn:li:activity:bad-url', url: 'not-a-url' }),
        observation({ externalId: 'urn:li:activity:ok' }),
      ],
    });

    expect(result.rejected).toBe(2);
    expect(result.written.map((r) => r.externalId)).toEqual(['urn:li:activity:ok']);
  });

  it('normalises blank optional fields to null without rejecting the entry', async () => {
    const db = getDb();
    const result = await ingestObservedTargets(db, {
      organizationId: orgAId,
      projectId: projectAId,
      platformId: linkedinId,
      observations: [observation({ authorHandle: '   ', authorName: undefined, text: '' })],
    });
    expect(result.rejected).toBe(0);
    expect(result.written).toHaveLength(1);
    expect(result.written[0].authorHandle).toBeNull();
    expect(result.written[0].authorName).toBeNull();
    expect(result.written[0].text).toBeNull();
  });

  it('throws rather than writing when the batch exceeds the cap', async () => {
    const db = getDb();
    const observations = Array.from({ length: MAX_OBSERVED_TARGETS_BATCH + 1 }, (_, i) =>
      observation({ externalId: `urn:li:activity:${i}` }),
    );
    await expect(
      ingestObservedTargets(db, {
        organizationId: orgAId,
        projectId: projectAId,
        platformId: linkedinId,
        observations,
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(schema.observedTargets);
    expect(rows).toHaveLength(0);
  });
});
