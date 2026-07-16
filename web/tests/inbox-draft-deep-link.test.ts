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

async function seed(state: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'deep-link-test', name: 'deep-link-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'tester' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
      state,
    })
    .returning();
  return { draft };
}

function loadEvent(url: string): RequestEvent {
  return {
    url: new URL(url),
    locals: {},
  } as unknown as RequestEvent;
}

describe('inbox loader honours a ?draft=<id> deep link regardless of default state filter', () => {
  beforeEach(reset);

  it('surfaces a sent draft when linked with ?draft=<id> and no explicit state', async () => {
    const { draft } = await seed('sent');

    // No `state` param - the default state filter is `pending_review`, which
    // would normally hide this sent draft. A `?draft=<id>` deep link must
    // still be able to find it.
    const data = await loadInbox(loadEvent(`http://x/inbox?draft=${draft.id}`));

    expect(data.drafts.some((d: { id: number }) => d.id === draft.id)).toBe(true);
  });

  it('still defaults to pending_review when no draft param is given', async () => {
    const { draft } = await seed('sent');

    const data = await loadInbox(loadEvent('http://x/inbox'));

    expect(data.state).toBe('pending_review');
    expect(data.drafts.some((d: { id: number }) => d.id === draft.id)).toBe(false);
  });

  it('lets an explicit state param still win over the draft-driven default', async () => {
    const { draft } = await seed('sent');

    const data = await loadInbox(
      loadEvent(`http://x/inbox?draft=${draft.id}&state=pending_review`),
    );

    expect(data.state).toBe('pending_review');
    expect(data.drafts.some((d: { id: number }) => d.id === draft.id)).toBe(false);
  });
});
