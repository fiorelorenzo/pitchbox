import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { search } from '../src/lib/server/search.js';
import { GET } from '../src/routes/api/search/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE messages, contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Seeds one org (the 'default' one when orgSlug is 'default', else a fresh org)
// with a project/account/campaign/run/draft/contact all sharing `label` in
// their searchable text, so different orgs seeded with the same label are
// still distinguishable by id in leak assertions.
async function seedOrg(orgSlug: string, label: string) {
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [org] =
    orgSlug === 'default'
      ? await db
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(sql`slug = 'default'`)
      : await db.insert(schema.organizations).values({ slug: orgSlug, name: orgSlug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${orgSlug}-proj-${Date.now()}`,
      name: `${label} Outreach`,
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: project.id,
      platformId: platform.id,
      handle: `${orgSlug}-me`,
      role: 'personal',
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: `${label} Founders Outreach`,
      skillSlug: 'reddit-scout',
      agentRunner: 'claude-code',
      status: 'active',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      projectId: project.id,
      agentRunner: 'claude-code',
      trigger: 'manual',
      status: 'completed',
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
      targetUser: `${label}Founder`,
      body: `Hello ${label}, loved your launch post.`,
    })
    .returning();
  await db.insert(schema.contactHistory).values({
    platformId: platform.id,
    accountHandle: `${orgSlug}-me`,
    targetUser: `${label}Founder`,
  });
  return { orgId: org.id, project, campaign, draft };
}

function fakeEvent(orgId: number, url: string): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL(url),
  } as unknown as RequestEvent;
}

afterAll(async () => {
  await getPool().end();
});

describe('search()', () => {
  beforeEach(reset);

  it('returns matching results across drafts, contacts, campaigns and projects', async () => {
    const { project, draft } = await seedOrg('default', 'Acme');
    const results = await search('acme', [project.id]);
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has('draft')).toBe(true);
    expect(kinds.has('contact')).toBe(true);
    expect(kinds.has('campaign')).toBe(true);
    expect(kinds.has('project')).toBe(true);
    // Every result must carry an href so the palette can navigate.
    for (const r of results) {
      expect(typeof r.href).toBe('string');
      expect(r.href.length).toBeGreaterThan(0);
    }
    // Draft results must use the `?draft=<id>` deep-link the inbox reads, the
    // same one Contacts/Audit produce (see inbox-draft-deep-link.test.ts).
    const draftResult = results.find((r) => r.kind === 'draft' && r.id === draft.id);
    expect(draftResult?.href).toBe(`/inbox?draft=${draft.id}`);
  });

  it('returns no results for an empty query (no static actions on server)', async () => {
    const { project } = await seedOrg('default', 'Acme');
    expect(await search('', [project.id])).toEqual([]);
    expect(await search('   ', [project.id])).toEqual([]);
  });

  it('does not return drafts/campaigns/projects outside the given project scope', async () => {
    const a = await seedOrg('search-scope-a', 'Widget');
    const b = await seedOrg('search-scope-b', 'Widget');

    const results = await search('widget', [a.project.id]);
    const nonContactIds = results
      .filter((r) => r.kind !== 'contact')
      .map((r) => `${r.kind}:${r.id}`);

    expect(nonContactIds).toContain(`draft:${a.draft.id}`);
    expect(nonContactIds).toContain(`campaign:${a.campaign.id}`);
    expect(nonContactIds).toContain(`project:${a.project.id}`);
    expect(nonContactIds).not.toContain(`draft:${b.draft.id}`);
    expect(nonContactIds).not.toContain(`campaign:${b.campaign.id}`);
    expect(nonContactIds).not.toContain(`project:${b.project.id}`);
  });

  it('guards an empty projectIds list without a SQL error', async () => {
    await seedOrg('default', 'Acme');
    const results = await search('acme', []);
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has('draft')).toBe(false);
    expect(kinds.has('campaign')).toBe(false);
    expect(kinds.has('project')).toBe(false);
  });
});

describe('GET /api/search is scoped to the active org', () => {
  beforeEach(reset);

  it('does not leak another org draft, campaign or project', async () => {
    const a = await seedOrg('search-route-leak-a', 'Rocket');
    const b = await seedOrg('search-route-leak-b', 'Rocket');

    const res = await GET(fakeEvent(a.orgId, 'http://x/api/search?q=rocket'));
    const body = (await res.json()) as { results: Array<{ kind: string; id: number | string }> };
    const ids = body.results.map((r) => `${r.kind}:${r.id}`);

    expect(ids).toContain(`draft:${a.draft.id}`);
    expect(ids).toContain(`campaign:${a.campaign.id}`);
    expect(ids).toContain(`project:${a.project.id}`);
    expect(ids).not.toContain(`draft:${b.draft.id}`);
    expect(ids).not.toContain(`campaign:${b.campaign.id}`);
    expect(ids).not.toContain(`project:${b.project.id}`);
  });
});
