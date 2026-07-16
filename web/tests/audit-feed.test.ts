import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { loadAuditFeed } from '../src/lib/server/audit-feed.js';

async function reset() {
  // Non-default orgs first, so their cascade wipes the rows a plain TRUNCATE
  // of the shared tables below would otherwise leave behind.
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events, run_events RESTART IDENTITY CASCADE`,
  );
}

async function getDefaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

async function seedFixture(orgId: number, slugPrefix = 'audit-test') {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: slugPrefix, name: slugPrefix })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: `tester-${slugPrefix}` })
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

  // Insert events at distinct timestamps so chronological order is unambiguous.
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-01T00:00:01Z');
  const t2 = new Date('2026-01-01T00:00:02Z');
  const t3 = new Date('2026-01-01T00:00:03Z');

  await db.insert(schema.draftEvents).values([
    { draftId: draft.id, event: 'created', actor: 'agent', details: {}, createdAt: t0 },
    { draftId: draft.id, event: 'approved', actor: 'user-1', details: {}, createdAt: t2 },
  ]);
  await db.insert(schema.runEvents).values([
    { runId: run.id, seq: 1, kind: 'started', payload: {}, raw: '{}', createdAt: t1 },
    { runId: run.id, seq: 2, kind: 'finished', payload: {}, raw: '{}', createdAt: t3 },
  ]);

  return { proj, draft, run };
}

describe('audit feed', () => {
  beforeEach(reset);

  it('returns rows from both draft_events and run_events in reverse chronological order', async () => {
    const orgId = await getDefaultOrgId();
    await seedFixture(orgId);
    const rows = await loadAuditFeed(orgId);
    expect(rows).toHaveLength(4);
    // newest first: finished (run, t3), approved (draft, t2), started (run, t1), created (draft, t0)
    expect(rows.map((r) => r.event)).toEqual(['finished', 'approved', 'started', 'created']);
    expect(rows.map((r) => r.kind)).toEqual(['run', 'draft', 'run', 'draft']);
    // run rows must carry runId and a null draftId; draft rows must carry draftId and a null runId.
    const finished = rows[0];
    expect(finished.runId).not.toBeNull();
    expect(finished.draftId).toBeNull();
    const approved = rows[1];
    expect(approved.draftId).not.toBeNull();
    expect(approved.runId).toBeNull();
    expect(approved.actor).toBe('user-1');
  });

  it('filters by event name across both legs', async () => {
    const orgId = await getDefaultOrgId();
    await seedFixture(orgId);
    const onlyApproved = await loadAuditFeed(orgId, { event: 'approved' });
    expect(onlyApproved).toHaveLength(1);
    expect(onlyApproved[0].kind).toBe('draft');
    expect(onlyApproved[0].event).toBe('approved');

    const onlyStarted = await loadAuditFeed(orgId, { event: 'started' });
    expect(onlyStarted).toHaveLength(1);
    expect(onlyStarted[0].kind).toBe('run');
    expect(onlyStarted[0].event).toBe('started');
  });

  it('filters by draft_id to the draft leg only', async () => {
    const orgId = await getDefaultOrgId();
    const { draft } = await seedFixture(orgId);
    const rows = await loadAuditFeed(orgId, { draftId: draft.id });
    expect(rows.every((r) => r.kind === 'draft')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("excludes another organization's draft_events and run_events from the feed", async () => {
    const defaultOrgId = await getDefaultOrgId();
    const [otherOrg] = await getDb()
      .insert(schema.organizations)
      .values({ slug: 'other-org', name: 'Other Org' })
      .returning();

    const { draft: defaultDraft, run: defaultRun } = await seedFixture(defaultOrgId, 'org-a');
    const { draft: otherDraft, run: otherRun } = await seedFixture(otherOrg.id, 'org-b');

    const orgARows = await loadAuditFeed(defaultOrgId);
    expect(orgARows).toHaveLength(4);
    expect(orgARows.every((r) => r.draftId !== otherDraft.id)).toBe(true);
    expect(orgARows.every((r) => r.runId !== otherRun.id)).toBe(true);
    expect(orgARows.some((r) => r.draftId === defaultDraft.id)).toBe(true);
    expect(orgARows.some((r) => r.runId === defaultRun.id)).toBe(true);

    const orgBRows = await loadAuditFeed(otherOrg.id);
    expect(orgBRows).toHaveLength(4);
    expect(orgBRows.every((r) => r.draftId !== defaultDraft.id)).toBe(true);
    expect(orgBRows.every((r) => r.runId !== defaultRun.id)).toBe(true);
    expect(orgBRows.some((r) => r.draftId === otherDraft.id)).toBe(true);
    expect(orgBRows.some((r) => r.runId === otherRun.id)).toBe(true);
  });
});
