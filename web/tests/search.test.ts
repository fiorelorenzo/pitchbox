import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { search } from '../src/routes/api/search/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE messages, contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [project] = await db
    .insert(schema.projects)
    .values({ slug: `proj-${Date.now()}`, name: 'Acme Outreach' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId: platform.id, handle: 'me', role: 'personal' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'Acme Founders Outreach',
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
  await db.insert(schema.drafts).values({
    runId: run.id,
    projectId: project.id,
    platformId: platform.id,
    accountId: account.id,
    kind: 'dm',
    state: 'pending_review',
    targetUser: 'acmeFounder',
    body: 'Hello Acme, loved your launch post.',
  });
  await db.insert(schema.contactHistory).values({
    platformId: platform.id,
    accountHandle: 'me',
    targetUser: 'acmeFounder',
  });
  return { project, campaign };
}

afterAll(async () => {
  await getPool().end();
});

describe('search endpoint', () => {
  beforeEach(reset);

  it('returns matching results across drafts, contacts, campaigns and projects', async () => {
    await seed();
    const results = await search('acme');
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
  });

  it('returns no results for an empty query (no static actions on server)', async () => {
    await seed();
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
  });
});
