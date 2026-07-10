import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load } from '../src/routes/campaigns/+page.server.js';
import { load as loadInbox } from '../src/routes/inbox/+page.server.js';

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
  return { orgId: org.id, projectId: project.id, campaignId: campaign.id, runId: run.id };
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

describe('inbox run/campaign context is scoped to the active org', () => {
  beforeEach(reset);

  it('does not leak another org campaign via ?campaign=<id>', async () => {
    const a = await seedOrgWithProject('inbox-leak-a');
    const b = await seedOrgWithProject('inbox-leak-b');

    const data = await loadInbox(fakeEvent(a.orgId, `http://x/inbox?campaign=${b.campaignId}`));
    expect(data.campaignInfo).toBeFalsy();
  });

  it('does not leak another org run via ?run=<id>', async () => {
    const a = await seedOrgWithProject('inbox-leak-c');
    const b = await seedOrgWithProject('inbox-leak-d');

    const data = await loadInbox(fakeEvent(a.orgId, `http://x/inbox?run=${b.runId}`));
    expect(data.runInfo).toBeFalsy();
  });

  it('returns campaign context for a same-org campaign id', async () => {
    const a = await seedOrgWithProject('inbox-leak-e');

    const data = await loadInbox(fakeEvent(a.orgId, `http://x/inbox?campaign=${a.campaignId}`));
    expect(data.campaignInfo).toBeTruthy();
    expect((data.campaignInfo as { id: number }).id).toBe(a.campaignId);
  });
});
