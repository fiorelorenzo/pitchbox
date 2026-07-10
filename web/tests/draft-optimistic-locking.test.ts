import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { updateDraftWithVersion } from '../src/lib/server/draft-state.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'olock-test', name: 'olock-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'tester' })
    .returning();
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
      body: 'hello',
      targetUser: 'someone',
      state: 'pending_review',
    })
    .returning();
  return { draft };
}

describe('draft optimistic locking', () => {
  beforeEach(reset);

  it('bumps version on a successful state transition', async () => {
    const { draft } = await seed();
    const res = await updateDraftWithVersion(draft.id, draft.version, { state: 'approved' });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.newVersion).toBe(draft.version + 1);
    const [fresh] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(fresh.state).toBe('approved');
    expect(fresh.version).toBe(draft.version + 1);
  });

  it('returns a conflict with the current version when versions mismatch', async () => {
    const { draft } = await seed();
    const first = await updateDraftWithVersion(draft.id, draft.version, { state: 'approved' });
    expect(first.kind).toBe('ok');
    const second = await updateDraftWithVersion(draft.id, draft.version, { state: 'rejected' });
    expect(second.kind).toBe('conflict');
    if (second.kind !== 'conflict') return;
    expect(second.currentVersion).toBe(draft.version + 1);
  });

  it('concurrent reject + approve resolves to exactly one ok and one conflict', async () => {
    const { draft } = await seed();
    const [a, b] = await Promise.all([
      updateDraftWithVersion(draft.id, draft.version, { state: 'approved' }),
      updateDraftWithVersion(draft.id, draft.version, { state: 'rejected' }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['conflict', 'ok']);
  });
});
