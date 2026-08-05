// #239: deep links carrying `?state=` and `?campaign=` (from the dashboard
// stat cards and the campaigns list) must actually filter the inbox, and a
// bogus `state` value must fall back to the default instead of throwing or
// silently rendering every draft as if it matched.
import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadInbox } from '../src/routes/inbox/+page.server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'filter-params-test', name: 'filter-params-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'tester' })
    .returning();

  const [campaignA] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'campaign-a', skillSlug: 's' })
    .returning();
  const [campaignB] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'campaign-b', skillSlug: 's' })
    .returning();
  const [runA] = await db
    .insert(schema.runs)
    .values({ campaignId: campaignA.id, trigger: 'manual', status: 'success' })
    .returning();
  const [runB] = await db
    .insert(schema.runs)
    .values({ campaignId: campaignB.id, trigger: 'manual', status: 'success' })
    .returning();

  async function draft(runId: number, state: string) {
    const [d] = await db
      .insert(schema.drafts)
      .values({
        runId,
        projectId: proj.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        body: 'hello',
        targetUser: 'someone',
        state,
      })
      .returning();
    return d;
  }

  // Matches both filters: campaign A, pending_review.
  const matching = await draft(runA.id, 'pending_review');
  // Same campaign, wrong state - must be excluded by the state filter.
  const wrongState = await draft(runA.id, 'approved');
  // Right state, different campaign - must be excluded by the campaign filter.
  const wrongCampaign = await draft(runB.id, 'pending_review');

  return { campaignA, matching, wrongState, wrongCampaign };
}

function loadEvent(url: string): RequestEvent {
  return {
    url: new URL(url),
    locals: {},
  } as unknown as RequestEvent;
}

describe('inbox loader honours ?state= and ?campaign= deep links (#239)', () => {
  beforeEach(reset);

  it('returns only the drafts matching both state and campaign', async () => {
    const { campaignA, matching, wrongState, wrongCampaign } = await seed();

    const data = await loadInbox(
      loadEvent(`http://x/inbox?state=pending_review&campaign=${campaignA.id}`),
    );

    const ids = data.drafts.map((d: { id: number }) => d.id);
    expect(ids).toEqual([matching.id]);
    expect(ids).not.toContain(wrongState.id);
    expect(ids).not.toContain(wrongCampaign.id);
    expect(data.stateFilterInvalid).toBeNull();
    expect(data.campaignFilterInvalid).toBeNull();
  });

  it('falls back to the default state instead of throwing on a bogus ?state=', async () => {
    const { matching, wrongState, wrongCampaign } = await seed();

    const data = await loadInbox(loadEvent('http://x/inbox?state=not-a-real-state'));

    // Fell back to the default (pending_review), not "all" - a bogus value
    // must never widen the filter into showing everything unfiltered.
    expect(data.state).toBe('pending_review');
    expect(data.stateFilterInvalid).toBe('not-a-real-state');
    const ids = data.drafts.map((d: { id: number }) => d.id);
    expect(ids).toContain(matching.id);
    expect(ids).toContain(wrongCampaign.id);
    expect(ids).not.toContain(wrongState.id);
  });

  it('ignores a non-numeric ?run= instead of erroring, and reports it as invalid', async () => {
    await seed();

    const data = await loadInbox(loadEvent('http://x/inbox?run=not-a-number'));

    expect(data.runFilterInvalid).toBe('not-a-number');
    expect(data.run).toBeNull();
  });
});
