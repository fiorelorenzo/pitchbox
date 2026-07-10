import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { PATCH as inboxPatch } from '../src/routes/inbox/[id]/+server.js';
import { GET as inboxEventsGet } from '../src/routes/inbox/[id]/events/+server.js';
import { GET as inboxReplyGet } from '../src/routes/inbox/[id]/reply/+server.js';
import { load as campaignLoad } from '../src/routes/campaigns/[id]/+page.server.js';
import { load as projectLoad } from '../src/routes/projects/[id]/+page.server.js';

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
  return {
    orgId: org.id,
    projectId: project.id,
    campaignId: campaign.id,
    accountId: account.id,
    runId: run.id,
    draftId: draft.id,
  };
}

function orgLocals(orgId: number) {
  return { org: { id: orgId, slug: 'x', role: 'owner' } };
}

function getEvent(orgId: number, id: number): RequestEvent {
  return {
    locals: orgLocals(orgId),
    params: { id: String(id) },
  } as unknown as RequestEvent;
}

// The page loaders are typed via the generated `PageServerLoad` (a
// `ServerLoadEvent`, stricter than the plain `RequestEvent` the `+server.ts`
// handlers take), so build their fake events with the loader's own inferred
// parameter type rather than a separately-declared `RequestEvent`.
function loadEvent<Load extends (event: never) => unknown>(
  orgId: number,
  id: number,
): Parameters<Load>[0] {
  return {
    locals: orgLocals(orgId),
    params: { id: String(id) },
  } as unknown as Parameters<Load>[0];
}

function patchEvent(orgId: number, draftId: number, body: unknown): RequestEvent {
  return {
    locals: orgLocals(orgId),
    params: { id: String(draftId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

describe('route guards on inbox/[id] and campaign/project detail pages', () => {
  beforeEach(reset);

  describe('PATCH /inbox/[id]', () => {
    it('rejects a draft owned by another org with 404', async () => {
      const a = await seedOrgWithProject('rgd-a');
      const b = await seedOrgWithProject('rgd-b');
      await expect(
        inboxPatch(patchEvent(b.orgId, a.draftId, { state: 'rejected' })),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('does not 404 for a draft owned by the caller org', async () => {
      const a = await seedOrgWithProject('rgd-c');
      const res = await inboxPatch(patchEvent(a.orgId, a.draftId, { state: 'rejected' }));
      expect(res.status).toBe(200);
    });
  });

  describe('GET /inbox/[id]/events', () => {
    it('rejects a draft owned by another org with 404', async () => {
      const a = await seedOrgWithProject('rge-a');
      const b = await seedOrgWithProject('rge-b');
      await expect(inboxEventsGet(getEvent(b.orgId, a.draftId))).rejects.toMatchObject({
        status: 404,
      });
    });

    it('returns data for a draft owned by the caller org', async () => {
      const a = await seedOrgWithProject('rge-c');
      const res = await inboxEventsGet(getEvent(a.orgId, a.draftId));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('GET /inbox/[id]/reply', () => {
    it('rejects a draft owned by another org with 404', async () => {
      const a = await seedOrgWithProject('rgy-a');
      const b = await seedOrgWithProject('rgy-b');
      await expect(inboxReplyGet(getEvent(b.orgId, a.draftId))).rejects.toMatchObject({
        status: 404,
      });
    });

    it('returns data for a draft owned by the caller org', async () => {
      const a = await seedOrgWithProject('rgy-c');
      const res = await inboxReplyGet(getEvent(a.orgId, a.draftId));
      expect(res.status).toBe(200);
      // No inbound message seeded, so the handler returns null, not a 404.
      const body = await res.json();
      expect(body).toBeNull();
    });
  });

  describe('load /campaigns/[id]', () => {
    it('rejects a campaign owned by another org with 404', async () => {
      const a = await seedOrgWithProject('rgcp-a');
      const b = await seedOrgWithProject('rgcp-b');
      await expect(
        campaignLoad(loadEvent<typeof campaignLoad>(b.orgId, a.campaignId)),
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('returns data for a campaign owned by the caller org', async () => {
      const a = await seedOrgWithProject('rgcp-c');
      const data = await campaignLoad(loadEvent<typeof campaignLoad>(a.orgId, a.campaignId));
      expect((data as { campaign: { id: number } }).campaign.id).toBe(a.campaignId);
    });
  });

  describe('load /projects/[id]', () => {
    it('rejects a project owned by another org with 404', async () => {
      const a = await seedOrgWithProject('rgpp-a');
      const b = await seedOrgWithProject('rgpp-b');
      await expect(
        projectLoad(loadEvent<typeof projectLoad>(b.orgId, a.projectId)),
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('returns data for a project owned by the caller org', async () => {
      const a = await seedOrgWithProject('rgpp-c');
      const data = await projectLoad(loadEvent<typeof projectLoad>(a.orgId, a.projectId));
      expect((data as { project: { id: number } }).project.id).toBe(a.projectId);
    });
  });
});
