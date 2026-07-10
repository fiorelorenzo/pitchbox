import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { PATCH } from '../src/routes/api/campaigns/[id]/+server.js';
import { POST as runPost } from '../src/routes/api/run/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from org-isolation.test.ts (no shared factory exists),
// extended to also return the seeded campaignId.
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

function patchEvent(
  orgId: number,
  campaignId: number,
  body: unknown = { name: 'renamed' },
): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    params: { id: String(campaignId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

function runEvent(
  campaignId: number,
  org?: { id: number; slug: string; role: string },
): RequestEvent {
  return {
    locals: org ? { org } : {},
    request: new Request('http://x/', {
      method: 'POST',
      body: JSON.stringify({ campaignId }),
    }),
  } as unknown as RequestEvent;
}

describe('campaign route guards', () => {
  beforeEach(reset);

  it('PATCH rejects a campaign owned by another org with 404', async () => {
    const a = await seedOrgWithProject('rgc-a');
    const b = await seedOrgWithProject('rgc-b');
    // Caller is org B, target campaign belongs to org A.
    await expect(PATCH(patchEvent(b.orgId, a.campaignId))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('POST /api/run rejects a campaign owned by another org with 404', async () => {
    const a = await seedOrgWithProject('rgr-a');
    const b = await seedOrgWithProject('rgr-b');
    // Caller is org B, target campaign belongs to org A.
    await expect(
      runPost(runEvent(a.campaignId, { id: b.orgId, slug: 'b', role: 'owner' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('POST /api/run with no locals.org (daemon/self-host path) is not tenant-rejected', async () => {
    const a = await seedOrgWithProject('rgr-c');
    // No `locals.org` at all, mirroring the daemon/self-host caller: the tenant
    // guard must be skipped entirely. The seeded campaign has an empty config,
    // so readiness fails downstream and the route returns a plain 422 (or, if
    // something else throws, it must not be the 404 tenant rejection) - either
    // way it proves the guard itself never fired.
    try {
      const res = await runPost(runEvent(a.campaignId));
      expect(res.status).not.toBe(404);
    } catch (err) {
      expect((err as { status?: number }).status).not.toBe(404);
    }
  });
});
