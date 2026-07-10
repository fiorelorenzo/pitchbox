import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load } from '../src/routes/campaigns/+page.server.js';

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from org-isolation.test.ts (no shared factory exists).
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
      name: `${slug}-cmp`,
      skillSlug: 'reddit-scout',
      status: 'active',
      config: {},
    })
    .returning();
  return { orgId: org.id, projectId: project.id, campaignId: campaign.id };
}

function fakeEvent(orgId: number, url: string): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL(url),
  } as unknown as RequestEvent;
}

describe('campaigns list is scoped to the active org', () => {
  beforeEach(reset);

  it('does not leak another org campaign when no project is selected', async () => {
    const a = await seedOrgWithProject('list-leak-a');
    const b = await seedOrgWithProject('list-leak-b');

    const data = await load(fakeEvent(a.orgId, 'http://x/campaigns'));
    const ids = data.campaigns.map((c: { id: number }) => c.id);
    expect(ids).toContain(a.campaignId);
    expect(ids).not.toContain(b.campaignId);
  });

  it('returns an empty campaign list for an org with no projects', async () => {
    const db = getDb();
    const [org] = await db
      .insert(schema.organizations)
      .values({ slug: 'list-leak-empty', name: 'list-leak-empty' })
      .returning();

    const data = await load(fakeEvent(org.id, 'http://x/campaigns'));
    expect(data.campaigns).toEqual([]);
    expect(data.projects).toEqual([]);
  });
});
