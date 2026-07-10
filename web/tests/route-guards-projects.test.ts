import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { GET as projectGet } from '../src/routes/api/projects/[id]/+server.js';
import { GET as runEventsGet } from '../src/routes/api/runs/[id]/events/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Copy of seedOrgWithProject from org-isolation.test.ts (no shared factory exists),
// also inserts campaign/account/run rows to satisfy check constraints and to
// give the runs/[id]/events guard case something to target.
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
  return {
    orgId: org.id,
    projectId: project.id,
    campaignId: campaign.id,
    accountId: account.id,
    runId: run.id,
  };
}

// A project_extraction run has projectId set and campaignId NULL (see
// runProjectExtraction in web/src/lib/server/runner.ts). runBelongsToOrg must
// resolve the org for this shape too, not just campaign-backed runs.
async function seedOrgWithExtractionRun(slug: string) {
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
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'project_extraction',
      projectId: project.id,
      agentRunner: 'claude-code',
      trigger: 'manual',
      status: 'succeeded',
    })
    .returning();
  return { orgId: org.id, projectId: project.id, runId: run.id };
}

function orgLocals(orgId: number) {
  return { org: { id: orgId, slug: 'x', role: 'owner' } };
}

function projectEvent(orgId: number, projectId: number): RequestEvent {
  return {
    locals: orgLocals(orgId),
    params: { id: String(projectId) },
  } as unknown as RequestEvent;
}

function runEventsEvent(orgId: number, runId: number): RequestEvent {
  return {
    locals: orgLocals(orgId),
    params: { id: String(runId) },
  } as unknown as RequestEvent;
}

describe('projects subtree and runs route guards', () => {
  beforeEach(reset);

  it('GET /api/projects/[id] rejects a project owned by another org with 404', async () => {
    const a = await seedOrgWithProject('rgp-a');
    const b = await seedOrgWithProject('rgp-b');
    // Caller is org B, target project belongs to org A.
    await expect(projectGet(projectEvent(b.orgId, a.projectId))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('GET /api/projects/[id] succeeds for a project owned by the caller org', async () => {
    const a = await seedOrgWithProject('rgp-c');
    const res = await projectGet(projectEvent(a.orgId, a.projectId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe(a.projectId);
  });

  it('GET /api/runs/[id]/events rejects a run owned by another org with 404', async () => {
    const a = await seedOrgWithProject('rgr-a');
    const b = await seedOrgWithProject('rgr-b');
    // Caller is org B, target run belongs to org A.
    await expect(runEventsGet(runEventsEvent(b.orgId, a.runId))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('GET /api/runs/[id]/events succeeds for a run owned by the caller org', async () => {
    const a = await seedOrgWithProject('rgr-c');
    const res = await runEventsGet(runEventsEvent(a.orgId, a.runId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe(a.runId);
  });

  it('GET /api/runs/[id]/events succeeds for a non-campaign run (project_extraction) owned by the caller org', async () => {
    const a = await seedOrgWithExtractionRun('rgr-pe-a');
    const res = await runEventsGet(runEventsEvent(a.orgId, a.runId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe(a.runId);
  });

  it('GET /api/runs/[id]/events rejects a non-campaign run (project_extraction) owned by another org with 404', async () => {
    const a = await seedOrgWithExtractionRun('rgr-pe-b');
    const b = await seedOrgWithExtractionRun('rgr-pe-c');
    await expect(runEventsGet(runEventsEvent(b.orgId, a.runId))).rejects.toMatchObject({
      status: 404,
    });
  });
});
