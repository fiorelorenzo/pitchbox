import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as campaignsListLoad } from '../src/routes/campaigns/+page.server.js';

/**
 * The Audit log renders every run as a link to `/campaigns?run=<id>`, whatever
 * kind of run it is. That list has no per-run view, so the loader resolves the
 * owner and redirects to the page that can expand and scroll to it.
 *
 * Only campaign runs used to resolve. A `project_extraction` or
 * `project_insights` run has `campaign_id` null and `project_id` set, so it
 * fell through to the invalid branch and the page told the user the id "is not
 * a valid run id". It is a perfectly valid run, just not a campaign one, and a
 * false error is worse than no link. Found while closing #259.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'arl', name: 'arl' })
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
      name: 'arl-cmp',
      skillSlug: 'reddit-scout',
      config: {},
    })
    .returning();
  const [campaignRun] = await db
    .insert(schema.runs)
    .values({ kind: 'campaign', campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [projectRun] = await db
    .insert(schema.runs)
    .values({
      kind: 'project_extraction',
      projectId: project.id,
      trigger: 'manual',
      status: 'success',
    })
    .returning();
  return { orgId: org.id, project, campaign, campaignRun, projectRun };
}

function listEvent(orgId: number, runParam?: string) {
  const url = new URL('http://x/campaigns');
  if (runParam !== undefined) url.searchParams.set('run', runParam);
  return {
    locals: { org: { id: orgId, slug: 'default', role: 'owner' } },
    url,
  } as unknown as Parameters<typeof campaignsListLoad>[0];
}

/** A thrown SvelteKit redirect, narrowed enough to assert on. */
function redirectOf(err: unknown): { status: number; location: string } {
  const r = err as { status?: number; location?: string };
  if (typeof r?.status !== 'number' || typeof r?.location !== 'string') {
    throw new Error(`expected a redirect, got ${JSON.stringify(err)}`);
  }
  return { status: r.status, location: r.location };
}

describe('audit run links resolve to the page that owns the run', () => {
  beforeEach(reset);

  it('sends a campaign run to its campaign detail page', async () => {
    const { orgId, campaign, campaignRun } = await seed();
    const err = await campaignsListLoad(listEvent(orgId, String(campaignRun.id))).catch((e) => e);
    expect(redirectOf(err).location).toBe(`/campaigns/${campaign.id}?run=${campaignRun.id}`);
  });

  it('sends a project run to its project page instead of calling it invalid', async () => {
    const { orgId, project, projectRun } = await seed();
    const err = await campaignsListLoad(listEvent(orgId, String(projectRun.id))).catch((e) => e);
    expect(redirectOf(err).location).toBe(`/projects/${project.id}?run=${projectRun.id}`);
  });

  it('still reports a genuinely unresolvable id rather than redirecting somewhere', async () => {
    const { orgId } = await seed();
    const data = await campaignsListLoad(listEvent(orgId, '999999'));
    expect(data.runFilterInvalid).toBe('999999');
  });

  it('reports a malformed id without touching the database for an owner', async () => {
    const { orgId } = await seed();
    const data = await campaignsListLoad(listEvent(orgId, 'not-a-number'));
    expect(data.runFilterInvalid).toBe('not-a-number');
  });

  it('leaves the list alone when there is no run parameter', async () => {
    const { orgId } = await seed();
    const data = await campaignsListLoad(listEvent(orgId));
    expect(data.runFilterInvalid).toBeNull();
    expect(data.campaigns.length).toBe(1);
  });
});
