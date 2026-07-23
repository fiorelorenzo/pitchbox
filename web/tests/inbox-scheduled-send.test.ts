import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadInbox } from '../src/routes/inbox/+page.server.js';
import { PATCH } from '../src/routes/inbox/[id]/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seed(overrides: { scheduledSendAfter?: Date | null; targetUser?: string } = {}) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'sched-send-test', name: 'sched-send-test' })
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
      targetUser: overrides.targetUser ?? 'someone',
      state: 'pending_review',
      scheduledSendAfter: overrides.scheduledSendAfter ?? null,
    })
    .returning();
  return { org, proj, platform, account, draft };
}

function loadEvent(url: string): RequestEvent {
  return {
    url: new URL(url),
    locals: {},
  } as unknown as RequestEvent;
}

function patchEvent(id: number, body: unknown): RequestEvent {
  return {
    locals: {},
    params: { id: String(id) },
    request: new Request(`http://localhost/inbox/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as RequestEvent;
}

describe('inbox loader surfaces scheduled_send_after', () => {
  beforeEach(reset);

  it('includes scheduledSendAfter on the returned drafts', async () => {
    const sendAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { draft } = await seed({ scheduledSendAfter: sendAfter });

    const data = await loadInbox(loadEvent('http://x/inbox'));
    const found = data.drafts.find((d: { id: number }) => d.id === draft.id) as
      { scheduledSendAfter: string | Date | null } | undefined;
    expect(found).toBeTruthy();
    expect(new Date(found!.scheduledSendAfter!).getTime()).toBe(sendAfter.getTime());
  });

  it('returns null scheduledSendAfter for a draft with no schedule', async () => {
    const { draft } = await seed();

    const data = await loadInbox(loadEvent('http://x/inbox'));
    const found = data.drafts.find((d: { id: number }) => d.id === draft.id) as
      { scheduledSendAfter: string | Date | null } | undefined;
    expect(found).toBeTruthy();
    expect(found!.scheduledSendAfter).toBeNull();
  });

  it('stamps the created contact_history with the draft org on manual send (#215)', async () => {
    const { org, draft } = await seed({ targetUser: 'replyguy' });

    const res = await PATCH(patchEvent(draft.id, { state: 'sent', version: draft.version }));
    expect(res.status).toBe(200);

    const [contact] = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draft.id));
    expect(contact).toBeTruthy();
    expect(contact.organizationId).toBe(org.id);
  });
});

describe('PATCH /inbox/[id] 409 error codes', () => {
  beforeEach(reset);

  it('rejects sending a draft scheduled in the future with a scheduled_send_after code', async () => {
    const sendAfter = new Date(Date.now() + 60 * 60 * 1000);
    const { draft } = await seed({ scheduledSendAfter: sendAfter });

    await expect(
      PATCH(patchEvent(draft.id, { state: 'sent', version: draft.version })),
    ).rejects.toMatchObject({
      status: 409,
      body: { message: `scheduled_send_after:${sendAfter.toISOString()}` },
    });
  });

  it('rejects sending a blocklisted target with a blocklisted code', async () => {
    const { draft, platform } = await seed({ targetUser: 'baduser' });
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: platform.id, kind: 'user', value: 'baduser', reason: 'spammer' });

    await expect(
      PATCH(patchEvent(draft.id, { state: 'sent', version: draft.version })),
    ).rejects.toMatchObject({
      status: 409,
      body: { message: 'blocklisted: spammer' },
    });
  });
});

describe('PATCH /inbox/[id] optimistic locking (GRD-3)', () => {
  beforeEach(reset);

  it('returns 409 version_conflict when a second PATCH reuses the version the first one already consumed', async () => {
    const { draft } = await seed();

    const first = await PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version }));
    expect(first.status).toBe(200);

    // Second dashboard tab, unaware the first tab already moved the row on,
    // races with the same stale version it originally observed.
    const second = await PATCH(patchEvent(draft.id, { state: 'rejected', version: draft.version }));
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; current_version: number };
    expect(body.error).toBe('version_conflict');
    expect(body.current_version).toBe(draft.version + 1);

    // The first write (approved) must be the one that stuck.
    const [fresh] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(fresh.state).toBe('approved');
  });
});
