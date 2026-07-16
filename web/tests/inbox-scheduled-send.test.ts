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
