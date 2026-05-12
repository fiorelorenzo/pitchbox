import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  projectBelongsToOrg,
  campaignBelongsToOrg,
  draftBelongsToOrg,
} from '@pitchbox/shared/orgs';

/**
 * Cross-tenant isolation: a project/campaign/draft created in org A must
 * never be visible to a query scoped to org B. The helpers in
 * `@pitchbox/shared/orgs` are the single chokepoint every server route
 * uses before returning a row, so we verify them directly.
 */

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrgWithProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${slug}-proj`,
      name: `${slug} project`,
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(sql`slug = 'reddit'`);
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'cmp',
      skillSlug: 'reddit-scout',
      status: 'active',
      config: {},
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: project.id,
      platformId: platform.id,
      handle: `${slug}-acc`,
      role: 'personal',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      projectId: project.id,
      agentRunner: 'claude-code',
      kind: 'campaign',
      trigger: 'manual',
      status: 'succeeded',
    })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      state: 'pending_review',
      targetUser: 'someone',
      body: 'hi',
    })
    .returning();
  return { orgId: org.id, projectId: project.id, campaignId: campaign.id, draftId: draft.id };
}

describe('cross-tenant isolation', () => {
  beforeEach(reset);

  it('project from org A is not visible to org B', async () => {
    const a = await seedOrgWithProject('org-a');
    const b = await seedOrgWithProject('org-b');
    const db = getDb();
    expect(await projectBelongsToOrg(db, a.projectId, a.orgId)).toBe(true);
    expect(await projectBelongsToOrg(db, a.projectId, b.orgId)).toBe(false);
  });

  it('campaign from org A is not visible to org B', async () => {
    const a = await seedOrgWithProject('org-a');
    const b = await seedOrgWithProject('org-b');
    const db = getDb();
    expect(await campaignBelongsToOrg(db, a.campaignId, a.orgId)).toBe(true);
    expect(await campaignBelongsToOrg(db, a.campaignId, b.orgId)).toBe(false);
  });

  it('draft from org A is not visible to org B', async () => {
    const a = await seedOrgWithProject('org-a');
    const b = await seedOrgWithProject('org-b');
    const db = getDb();
    expect(await draftBelongsToOrg(db, a.draftId, a.orgId)).toBe(true);
    expect(await draftBelongsToOrg(db, a.draftId, b.orgId)).toBe(false);
  });
});
