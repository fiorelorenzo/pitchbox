// Covers #234: cronExpression was accepted as z.string().min(1) with no
// validation, so a typo (or anything cron-parser can't parse) saved happily
// and the campaign then never ran, with nothing explaining why. POST and
// PATCH now validate with the same library the scheduler daemon uses
// (@pitchbox/daemon/cron, backed by cron-parser) and reject an unparseable
// expression before it reaches the database, returning the parser's own
// error message instead of a generic "invalid" response.

import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as campaignsPost } from '../src/routes/api/campaigns/+server.js';
import { PATCH as campaignsPatch } from '../src/routes/api/campaigns/[id]/+server.js';

// A runner slug that isn't registered in AGENT_RUNNERS: createAgentRunner
// throws synchronously before anything spawns, so dispatchRun's catch marks
// the freshly-created skill-generation run 'failed' immediately (no real
// agent process, no network, no CLI dependency) while POST /api/campaigns
// itself still returns 201 - same convention as campaign-scenario-autopost.test.ts.
const NO_OP_RUNNER = 'test-no-such-runner';

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from campaign-scenario-autopost.test.ts /
// org-isolation.test.ts (no shared factory exists).
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
  return { orgId: org.id, projectId: project.id };
}

async function platformId(slug: string): Promise<number> {
  const [platform] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  if (!platform) throw new Error(`platform "${slug}" is not seeded - did global-setup run?`);
  return platform.id;
}

async function seedCampaign(slug: string) {
  const { orgId, projectId } = await seedOrgWithProject(slug);
  const platform = await platformId('reddit');
  const [campaign] = await getDb()
    .insert(schema.campaigns)
    .values({ projectId, platformId: platform, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  return { orgId, campaignId: campaign.id };
}

function postEvent(orgId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'member' } },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

function patchEvent(orgId: number, campaignId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'member' } },
    params: { id: String(campaignId) },
    request: new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

describe('cron expression validation (#234)', () => {
  beforeEach(reset);

  describe('POST /api/campaigns', () => {
    it('rejects an unparseable cron expression with a useful message and does not persist the campaign', async () => {
      const { orgId, projectId } = await seedOrgWithProject('cron-post-bad');

      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'reddit',
          scenarioSlug: 'reddit-scout',
          name: 'Bad cron campaign',
          objective: 'test',
          agentRunner: NO_OP_RUNNER,
          cronExpression: 'not a cron expression',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_cron');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);

      const rows = await getDb().select().from(schema.campaigns);
      expect(rows).toHaveLength(0);
    });

    it('rejects an out-of-range cron field the same way', async () => {
      const { orgId, projectId } = await seedOrgWithProject('cron-post-range');

      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'reddit',
          scenarioSlug: 'reddit-scout',
          name: 'Bad cron campaign',
          objective: 'test',
          agentRunner: NO_OP_RUNNER,
          cronExpression: '99 99 * * *',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_cron');
    });

    it('accepts a valid cron expression and persists it', async () => {
      const { orgId, projectId } = await seedOrgWithProject('cron-post-good');

      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'reddit',
          scenarioSlug: 'reddit-scout',
          name: 'Good cron campaign',
          objective: 'test',
          agentRunner: NO_OP_RUNNER,
          cronExpression: '0 9 * * *',
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      const [campaign] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, body.id));
      expect(campaign.cronExpression).toBe('0 9 * * *');
    });

    it('creates the campaign with no schedule when cronExpression is omitted', async () => {
      const { orgId, projectId } = await seedOrgWithProject('cron-post-none');

      const res = await campaignsPost(
        postEvent(orgId, {
          projectId,
          platformSlug: 'reddit',
          scenarioSlug: 'reddit-scout',
          name: 'No cron campaign',
          objective: 'test',
          agentRunner: NO_OP_RUNNER,
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      const [campaign] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, body.id));
      expect(campaign.cronExpression).toBeNull();
    });
  });

  describe('PATCH /api/campaigns/[id]', () => {
    it('rejects an unparseable cron expression and leaves the campaign unscheduled', async () => {
      const { orgId, campaignId } = await seedCampaign('cron-patch-bad');

      const res = await campaignsPatch(
        patchEvent(orgId, campaignId, { cronExpression: '99 99 * * *' }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_cron');
      expect(typeof body.message).toBe('string');

      const [row] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      expect(row.cronExpression).toBeNull();
    });

    it('accepts a valid cron expression and seeds the next run time', async () => {
      const { orgId, campaignId } = await seedCampaign('cron-patch-good');

      const res = await campaignsPatch(
        patchEvent(orgId, campaignId, { cronExpression: '*/15 * * * *' }),
      );

      expect(res.status).toBe(200);
      const [row] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      expect(row.cronExpression).toBe('*/15 * * * *');
      expect(row.nextRunAt).not.toBeNull();
      expect(new Date(row.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it('clears the schedule (and the next run time) when cronExpression is null', async () => {
      const { orgId, campaignId } = await seedCampaign('cron-patch-null');
      await getDb()
        .update(schema.campaigns)
        .set({ cronExpression: '0 9 * * *', nextRunAt: new Date() })
        .where(eq(schema.campaigns.id, campaignId));

      const res = await campaignsPatch(patchEvent(orgId, campaignId, { cronExpression: null }));

      expect(res.status).toBe(200);
      const [row] = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      expect(row.cronExpression).toBeNull();
      expect(row.nextRunAt).toBeNull();
    });
  });
});
