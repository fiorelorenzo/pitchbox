import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { cascadeRejectSiblings, groupVariants, variantLabelFor } from '../src/draft-variants.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

async function setupGroup(bodies: string[]) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'var-test', name: 'var-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'varuser' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const grouped = groupVariants(bodies.map((b) => ({ body: b })));
  const inserted = await db
    .insert(schema.drafts)
    .values(
      grouped.rows.map((r) => ({
        runId: run.id,
        projectId: proj.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        body: r.body,
        targetUser: 'someone',
        variantGroupId: r.variantGroupId,
        variantLabel: r.variantLabel,
      })),
    )
    .returning();
  return { db, drafts: inserted, groupId: grouped.variantGroupId };
}

describe('draft-variants', () => {
  beforeEach(reset);

  it('labels variants A, B, C', () => {
    expect(variantLabelFor(0)).toBe('A');
    expect(variantLabelFor(1)).toBe('B');
    expect(variantLabelFor(2)).toBe('C');
  });

  it('groupVariants shares a single variant_group_id with sequential labels', () => {
    const g = groupVariants([{ body: 'one' }, { body: 'two' }, { body: 'three' }]);
    expect(g.rows.map((r) => r.variantLabel)).toEqual(['A', 'B', 'C']);
    expect(new Set(g.rows.map((r) => r.variantGroupId)).size).toBe(1);
    expect(g.rows[0].variantGroupId).toBe(g.variantGroupId);
  });

  it('cascadeRejectSiblings flips other variants to rejected with variant_lost reason', async () => {
    const { db, drafts, groupId } = await setupGroup(['v-a', 'v-b', 'v-c']);
    const winner = drafts[0];
    const res = await cascadeRejectSiblings(db, groupId, winner.id, 'user');
    expect(res.rejectedIds).toHaveLength(2);

    const rows = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.variantGroupId, groupId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(winner.id)!.state).toBe('pending_review');
    for (const id of res.rejectedIds) {
      expect(byId.get(id)!.state).toBe('rejected');
    }

    const events = await db.select().from(schema.draftEvents);
    const lostEvents = events.filter(
      (e) =>
        e.event === 'rejected' && (e.details as Record<string, unknown>).reason === 'variant_lost',
    );
    expect(lostEvents).toHaveLength(2);
  });

  it('cascadeRejectSiblings is idempotent (already-rejected siblings are skipped)', async () => {
    const { db, drafts, groupId } = await setupGroup(['v-a', 'v-b']);
    await cascadeRejectSiblings(db, groupId, drafts[0].id, 'user');
    const second = await cascadeRejectSiblings(db, groupId, drafts[0].id, 'user');
    expect(second.rejectedIds).toHaveLength(0);
  });
});
