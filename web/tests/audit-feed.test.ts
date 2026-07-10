import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { loadAuditFeed } from '../src/lib/server/audit-feed.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events, run_events RESTART IDENTITY CASCADE`,
  );
}

async function seedFixture() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'audit-test', name: 'audit-test' })
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

  return { draft, run };
}

describe('audit feed', () => {
  beforeEach(reset);

  it('returns rows from both draft_events and run_events in reverse chronological order', async () => {
    await seedFixture();
    const rows = await loadAuditFeed();
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
    await seedFixture();
    const onlyApproved = await loadAuditFeed({ event: 'approved' });
    expect(onlyApproved).toHaveLength(1);
    expect(onlyApproved[0].kind).toBe('draft');
    expect(onlyApproved[0].event).toBe('approved');

    const onlyStarted = await loadAuditFeed({ event: 'started' });
    expect(onlyStarted).toHaveLength(1);
    expect(onlyStarted[0].kind).toBe('run');
    expect(onlyStarted[0].event).toBe('started');
  });

  it('filters by draft_id to the draft leg only', async () => {
    const { draft } = await seedFixture();
    const rows = await loadAuditFeed({ draftId: draft.id });
    expect(rows.every((r) => r.kind === 'draft')).toBe(true);
    expect(rows).toHaveLength(2);
  });
});
