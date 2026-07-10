import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { PATCH } from '../src/routes/api/drafts/[id]/+server.js';

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
      name: `${slug} p`,
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(sql`slug = 'reddit'`);
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: project.id,
      platformId: platform.id,
      handle: `${slug}-a`,
      role: 'personal',
    })
    .returning();
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
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      state: 'pending_review',
      targetUser: 'u',
      body: 'hi',
      version: 1,
    })
    .returning();
  return { orgId: org.id, draftId: draft.id, version: draft.version };
}

function patchEvent(orgId: number, draftId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' }, user: { id: 1, username: 'x' } },
    params: { id: String(draftId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

describe('drafts PATCH tenant guard', () => {
  beforeEach(reset);

  it('rejects a draft owned by another org with 404', async () => {
    const a = await seedOrgWithProject('rg-a');
    const b = await seedOrgWithProject('rg-b');
    // Caller is org B, target draft belongs to org A.
    await expect(
      PATCH(patchEvent(b.orgId, a.draftId, { expectedVersion: a.version, body: 'x' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});
