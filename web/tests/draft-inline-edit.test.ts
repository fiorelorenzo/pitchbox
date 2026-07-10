import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq, desc } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { PATCH } from '../src/routes/api/drafts/[id]/+server.js';

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
    .values({ organizationId: org.id, slug: 'inline-edit-test', name: 'inline-edit-test' })
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
      body: 'original body',
      targetUser: 'someone',
      state,
    })
    .returning();
  return { draft };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/drafts/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/drafts/[id]', () => {
  beforeEach(reset);

  it('updates body, sets body_edited, bumps version, logs event', async () => {
    const { draft } = await seed('pending_review');
    const res = await PATCH({
      params: { id: String(draft.id) },
      request: makeRequest({ body: 'rewritten body', version: draft.version }),
      locals: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(draft.version + 1);

    const [fresh] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(fresh.body).toBe('rewritten body');
    expect(fresh.bodyEdited).toBe(true);

    const [evt] = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id))
      .orderBy(desc(schema.draftEvents.id))
      .limit(1);
    expect(evt.event).toBe('body_edited');
    expect((evt.details as { priorBody?: string }).priorBody).toBe('original body');
  });

  it('returns 409 when state has advanced past review', async () => {
    const { draft } = await seed('approved');
    const res = await PATCH({
      params: { id: String(draft.id) },
      request: makeRequest({ body: 'late edit', version: draft.version }),
      locals: {},
    } as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('state_locked');
  });
});
