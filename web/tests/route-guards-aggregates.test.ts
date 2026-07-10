import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as homeLoad } from '../src/routes/+page.server.js';
import { load as blocklistLoad } from '../src/routes/blocklist/+page.server.js';
import { load as analyticsLoad } from '../src/routes/analytics/+page.server.js';
import { load as newCampaignLoad } from '../src/routes/campaigns/new/+page.server.js';
import { GET as extensionDevicesGet } from '../src/routes/api/settings/extension-devices/+server.js';
import { DELETE as extensionDeviceDelete } from '../src/routes/api/settings/extension-devices/[id]/+server.js';

/**
 * Cross-org exclusion for the unscoped list/aggregate loaders and the
 * extension-devices routes found by the final review of the
 * organization-isolation feature (Task 13b). These sit alongside the by-id
 * detail-page guards covered by route-guards-detail-pages.test.ts.
 */

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, extension_devices RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from org-isolation.test.ts / route-guards-detail-pages.test.ts
// (no shared factory exists), extended with a contact_history row, a
// project-scoped blocklist row, and an extension_devices row so every
// surface under test in this file has org-A / org-B fixtures.
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
      state: 'sent',
      targetUser: `${slug}-target`,
      body: 'hi',
      sentAt: new Date(),
    })
    .returning();
  await db.insert(schema.contactHistory).values({
    platformId: platform.id,
    accountHandle: account.handle,
    targetUser: draft.targetUser as string,
    draftId: draft.id,
    lastContactedAt: new Date(),
  });
  const [blocklistRow] = await db
    .insert(schema.blocklist)
    .values({
      platformId: platform.id,
      kind: 'user',
      value: `${slug}-blocked`,
      scope: 'project',
      projectId: project.id,
    })
    .returning();
  const [device] = await db
    .insert(schema.extensionDevices)
    .values({
      organizationId: org.id,
      label: `${slug}-device`,
      tokenHash: `${slug}-hash`,
    })
    .returning();
  return {
    orgId: org.id,
    projectId: project.id,
    campaignId: campaign.id,
    runId: run.id,
    draftId: draft.id,
    blocklistId: blocklistRow.id,
    deviceId: device.id,
  };
}

function orgLocals(orgId: number) {
  return { org: { id: orgId, slug: 'x', role: 'owner' } };
}

function fakeEvent(orgId: number, url = 'http://x/'): RequestEvent {
  return {
    locals: orgLocals(orgId),
    url: new URL(url),
  } as unknown as RequestEvent;
}

// campaigns/new's loader is typed via the generated `PageServerLoad` (a
// `ServerLoadEvent`, stricter than the plain `RequestEvent` the other
// loaders in this file take), so build its fake event with the loader's own
// inferred parameter type - same approach as route-guards-detail-pages.test.ts.
function loadEvent<Load extends (event: never) => unknown>(
  orgId: number,
  url = 'http://x/',
): Parameters<Load>[0] {
  return {
    locals: orgLocals(orgId),
    url: new URL(url),
  } as unknown as Parameters<Load>[0];
}

describe('route guards on aggregate/list loaders and extension-devices', () => {
  beforeEach(reset);

  describe('load / (home dashboard)', () => {
    it('scopes campaigns, recent runs, and draft stats to the active org', async () => {
      const a = await seedOrgWithProject('rga-a');
      const b = await seedOrgWithProject('rga-b');
      const data = (await homeLoad(fakeEvent(a.orgId))) as {
        campaigns: { id: number }[];
        recentRuns: { id: number }[];
        stats: { total: number };
      };
      const campaignIds = data.campaigns.map((c) => c.id);
      expect(campaignIds).toContain(a.campaignId);
      expect(campaignIds).not.toContain(b.campaignId);
      const runIds = data.recentRuns.map((r) => r.id);
      expect(runIds).toContain(a.runId);
      expect(runIds).not.toContain(b.runId);
      // Draft-state counts (drives sent/created-today too) - only org A's draft.
      expect(data.stats.total).toBe(1);
    });

    it('counts a campaign-kind run that only has campaignId set (no projectId), the way runCampaign actually creates it', async () => {
      // Task 13c regression: runCampaign (web/src/lib/server/runner.ts) inserts
      // runs with ONLY campaignId set - projectId is left NULL - so a filter on
      // runs.projectId alone (`inArray`) silently drops every campaign run. The
      // fixture above sets projectId explicitly and does not cover this.
      const a = await seedOrgWithProject('rga-camp-a');
      const b = await seedOrgWithProject('rga-camp-b');
      const db = getDb();
      const [bareRun] = await db
        .insert(schema.runs)
        .values({
          campaignId: a.campaignId,
          agentRunner: 'claude-code',
          kind: 'campaign',
          trigger: 'manual',
          status: 'succeeded',
          costUsd: '1.5000',
        })
        .returning();

      const dataA = (await homeLoad(fakeEvent(a.orgId))) as {
        recentRuns: { id: number }[];
        campaigns: { id: number; lastRunId: number | null }[];
        runStats7d: { total: number };
        spend: { cost24h: number; cost7d: number };
      };
      const recentRunIdsA = dataA.recentRuns.map((r) => r.id);
      expect(recentRunIdsA).toContain(bareRun.id);
      const campaignA = dataA.campaigns.find((c) => c.id === a.campaignId);
      expect(campaignA?.lastRunId).toBe(bareRun.id);
      expect(dataA.runStats7d.total).toBeGreaterThanOrEqual(1);
      expect(dataA.spend.cost7d).toBeGreaterThanOrEqual(1.5);

      const dataB = (await homeLoad(fakeEvent(b.orgId))) as {
        recentRuns: { id: number }[];
      };
      expect(dataB.recentRuns.map((r) => r.id)).not.toContain(bareRun.id);
    });

    it('returns zeroed stats and empty lists for an org with no projects', async () => {
      const [org] = await getDb()
        .insert(schema.organizations)
        .values({ slug: 'rga-empty', name: 'rga-empty' })
        .returning();
      const data = await homeLoad(fakeEvent(org.id));
      expect(data).toMatchObject({
        campaigns: [],
        recentRuns: [],
        stats: { total: 0, uniqueContacts: 0, replies: 0 },
        spend: { cost24h: 0, cost7d: 0 },
      });
    });
  });

  describe('load /blocklist', () => {
    it('excludes a project-scoped row from another org but keeps global rows and scopes the project picker', async () => {
      const a = await seedOrgWithProject('rgb-a');
      const b = await seedOrgWithProject('rgb-b');
      const db = getDb();
      const [platform] = await db
        .select()
        .from(schema.platforms)
        .where(sql`slug = 'reddit'`);
      const [globalRow] = await db
        .insert(schema.blocklist)
        .values({
          platformId: platform.id,
          kind: 'user',
          value: 'rgb-global-blocked',
          scope: 'global',
        })
        .returning();

      const data = (await blocklistLoad(fakeEvent(a.orgId))) as {
        entries: { id: number }[];
        projects: { id: number }[];
      };
      const entryIds = data.entries.map((e) => e.id);
      expect(entryIds).toContain(a.blocklistId);
      expect(entryIds).not.toContain(b.blocklistId);
      expect(entryIds).toContain(globalRow.id);

      const projectIds = data.projects.map((p) => p.id);
      expect(projectIds).toContain(a.projectId);
      expect(projectIds).not.toContain(b.projectId);
    });
  });

  describe('load /analytics', () => {
    it('excludes another org campaign from the campaign-picker dropdown', async () => {
      const a = await seedOrgWithProject('rgan-a');
      const b = await seedOrgWithProject('rgan-b');
      const data = (await analyticsLoad(fakeEvent(a.orgId))) as { campaigns: { id: number }[] };
      const ids = data.campaigns.map((c) => c.id);
      expect(ids).toContain(a.campaignId);
      expect(ids).not.toContain(b.campaignId);
    });
  });

  describe('load /campaigns/new', () => {
    it('excludes another org project from the project picker', async () => {
      const a = await seedOrgWithProject('rgcn-a');
      const b = await seedOrgWithProject('rgcn-b');
      const data = (await newCampaignLoad(loadEvent<typeof newCampaignLoad>(a.orgId))) as {
        projects: { id: number }[];
      };
      const ids = data.projects.map((p) => p.id);
      expect(ids).toContain(a.projectId);
      expect(ids).not.toContain(b.projectId);
    });
  });

  describe('GET /api/settings/extension-devices', () => {
    it('excludes a device belonging to another org', async () => {
      const a = await seedOrgWithProject('rged-a');
      const b = await seedOrgWithProject('rged-b');
      const res = await extensionDevicesGet(fakeEvent(a.orgId));
      const body = (await res.json()) as { devices: { id: number }[] };
      const ids = body.devices.map((d) => d.id);
      expect(ids).toContain(a.deviceId);
      expect(ids).not.toContain(b.deviceId);
    });
  });

  describe('DELETE /api/settings/extension-devices/[id]', () => {
    it('404s deleting a device owned by another org and leaves it un-revoked', async () => {
      const a = await seedOrgWithProject('rgedd-a');
      const b = await seedOrgWithProject('rgedd-b');
      const event = {
        locals: orgLocals(a.orgId),
        params: { id: String(b.deviceId) },
      } as unknown as RequestEvent;
      await expect(extensionDeviceDelete(event)).rejects.toMatchObject({ status: 404 });
      const [device] = await getDb()
        .select({ revokedAt: schema.extensionDevices.revokedAt })
        .from(schema.extensionDevices)
        .where(eq(schema.extensionDevices.id, b.deviceId));
      expect(device.revokedAt).toBeNull();
    });

    it('revokes a device owned by the caller org', async () => {
      const a = await seedOrgWithProject('rgedd-c');
      const event = {
        locals: orgLocals(a.orgId),
        params: { id: String(a.deviceId) },
      } as unknown as RequestEvent;
      const res = await extensionDeviceDelete(event);
      expect(res.status).toBe(200);
      const [device] = await getDb()
        .select({ revokedAt: schema.extensionDevices.revokedAt })
        .from(schema.extensionDevices)
        .where(eq(schema.extensionDevices.id, a.deviceId));
      expect(device.revokedAt).not.toBeNull();
    });
  });
});
