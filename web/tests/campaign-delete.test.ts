import { describe, expect, it, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { DELETE } from '../src/routes/api/campaigns/[id]/+server.js';

// #225: a campaign had no delete at all. The contract this locks down is the
// blast radius (runs/drafts go, contact history stays) and the two refusals
// (wrong name, live run) that keep the delete from being a footgun.
async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seed(slug: string, runStatus = 'success') {
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
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: `${slug} campaign`,
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
      trigger: 'manual',
      status: runStatus,
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: project.id,
      platformId: platform.id,
      handle: `${slug}-acct`,
      role: 'personal',
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
      targetUser: 'alice',
      body: 'hi',
      state: 'sent',
    })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: `${slug}-acct`,
      organizationId: org.id,
      targetUser: 'alice',
      draftId: draft.id,
    })
    .returning();
  return {
    orgId: org.id,
    campaignId: campaign.id,
    campaignName: campaign.name,
    runId: run.id,
    draftId: draft.id,
    contactId: contact.id,
  };
}

function deleteEvent(
  campaignId: number,
  body: unknown,
  locals: Record<string, unknown>,
): RequestEvent {
  return {
    locals,
    params: { id: String(campaignId) },
    request: new Request(`http://x/api/campaigns/${campaignId}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as RequestEvent;
}

const asRole = (orgId: number, role: string) => ({ org: { id: orgId, slug: 'x', role } });

describe('DELETE /api/campaigns/[id]', () => {
  beforeEach(reset);

  it('deletes the campaign with its runs and drafts, and keeps contact history', async () => {
    const s = await seed('del-ok');
    const db = getDb();

    const res = await DELETE(
      deleteEvent(s.campaignId, { confirmName: s.campaignName }, asRole(s.orgId, 'admin')),
    );
    expect(res.status).toBe(200);

    const campaigns = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, s.campaignId));
    expect(campaigns).toHaveLength(0);
    const runs = await db.select().from(schema.runs).where(eq(schema.runs.id, s.runId));
    expect(runs).toHaveLength(0);
    const drafts = await db.select().from(schema.drafts).where(eq(schema.drafts.id, s.draftId));
    expect(drafts).toHaveLength(0);

    // The point of the cascade choice: who we already contacted outlives the
    // campaign, so a deleted campaign can never resurrect a target.
    const [contact] = await db
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.id, s.contactId));
    expect(contact).toBeTruthy();
    expect(contact.draftId).toBeNull();
    expect(contact.targetUser).toBe('alice');
  });

  it('refuses a mismatched confirmation name and keeps the campaign', async () => {
    const s = await seed('del-mismatch');
    const res = await DELETE(
      deleteEvent(s.campaignId, { confirmName: 'something else' }, asRole(s.orgId, 'admin')),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'name_mismatch' });

    const rows = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, s.campaignId));
    expect(rows).toHaveLength(1);
  });

  it('refuses while a run is in flight rather than cascading it out from under the runner', async () => {
    for (const status of ['queued', 'running']) {
      await reset();
      const s = await seed(`del-${status}`, status);
      const res = await DELETE(
        deleteEvent(s.campaignId, { confirmName: s.campaignName }, asRole(s.orgId, 'admin')),
      );
      expect(res.status, status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: 'run_in_flight', runId: s.runId });

      const rows = await getDb()
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, s.campaignId));
      expect(rows, status).toHaveLength(1);
    }
  });

  it('rejects a member: deleting is admin-only', async () => {
    const s = await seed('del-member');
    await expect(
      DELETE(deleteEvent(s.campaignId, { confirmName: s.campaignName }, asRole(s.orgId, 'member'))),
    ).rejects.toMatchObject({ status: 403 });

    const rows = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, s.campaignId));
    expect(rows).toHaveLength(1);
  });

  it('rejects another org with 404 before the role gate', async () => {
    const mine = await seed('del-mine');
    const theirs = await seed('del-theirs');
    await expect(
      DELETE(
        deleteEvent(
          theirs.campaignId,
          { confirmName: theirs.campaignName },
          asRole(mine.orgId, 'owner'),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });

    const rows = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, theirs.campaignId));
    expect(rows).toHaveLength(1);
  });

  it('rejects a body with no confirmation name', async () => {
    const s = await seed('del-nobody');
    const res = await DELETE(deleteEvent(s.campaignId, {}, asRole(s.orgId, 'admin')));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_body' });
  });
});
