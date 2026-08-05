import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  load as loadPeople,
  type PeoplePageData,
  type ContactsTabData,
} from '../src/routes/people/+page.server.js';

/**
 * Cross-tenant isolation for the Contacts page (#263). `contact_history.
 * organization_id` is NOT NULL and always matches the org of the row's
 * draft's project, so a cross-org contact row must be entirely absent from
 * the list and its aggregate counts, not merely have its draft fields
 * nulled - see docs/organization-isolation-design.md.
 */

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE messages, contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Seeds an org with a project, a sent DM draft, and a contact_history row
// attributed to that draft.
async function seedOrgContact(slug: string) {
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
      body: `${slug}-secret-draft-body`,
    })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: `${slug}-acc`,
      targetUser: `${slug}-target`,
      draftId: draft.id,
      organizationId: org.id,
      lastContactedAt: new Date('2026-05-01T10:00:00Z'),
    })
    .returning();
  return { orgId: org.id, projectId: project.id, draftId: draft.id, contactId: contact.id };
}

function fakeEvent(orgId: number, url: string): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL(url),
    params: {},
  } as unknown as RequestEvent;
}

// `/people`'s loader returns a discriminated union keyed on `tab`
// (contacts-shaped vs. threads-shaped data - see +page.server.ts); narrow
// on the real discriminant rather than asserting the whole result.
function asContactsTab(data: PeoplePageData): ContactsTabData {
  if (data.tab !== 'contacts') throw new Error('expected the contacts tab');
  return data;
}

describe('contacts page is scoped to the active org', () => {
  beforeEach(reset);

  it('excludes a cross-org contact row entirely, from both the list and the totals', async () => {
    const a = await seedOrgContact('contacts-a');
    const b = await seedOrgContact('contacts-b');

    const data = asContactsTab(
      await loadPeople(fakeEvent(a.orgId, 'http://x/people?tab=contacts')),
    );
    const rowA = data.contacts.find((c: { id: number }) => c.id === a.contactId);
    const rowB = data.contacts.find((c: { id: number }) => c.id === b.contactId);

    expect(rowA).toBeTruthy();
    expect(rowA?.draftKind).toBe('dm');
    expect(rowA?.draftState).toBe('sent');
    expect(rowA?.draftRunId).not.toBeNull();

    // contact_history is org-scoped (#263): org B's contact row must not
    // appear at all when loading as org A, and must not inflate org A's
    // aggregate totals either.
    expect(rowB).toBeUndefined();
    expect(data.matchingCount).toBe(1);
    expect(data.totals.total).toBe(1);
  });
});
