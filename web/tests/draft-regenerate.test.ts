import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq, desc } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST } from '../src/routes/api/drafts/[id]/regenerate/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events, draft_regeneration_hints RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'regen-test', name: 'regen-test' })
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
      body: 'first take',
      targetUser: 'someone',
      state: 'pending_review',
    })
    .returning();
  return { draft };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/drafts/1/regenerate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/drafts/[id]/regenerate', () => {
  beforeEach(reset);

  it('increments regeneration_count, persists hint, appends a draft_event', async () => {
    const { draft } = await seed();
    const res = await POST({
      params: { id: String(draft.id) },
      request: makeRequest({ hint: 'shorter and warmer' }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      regenerationCount: number;
      hintId: number | null;
    };
    expect(body.ok).toBe(true);
    expect(body.regenerationCount).toBe(1);
    expect(body.hintId).not.toBeNull();

    const [fresh] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(fresh.regenerationCount).toBe(1);

    const [hint] = await getDb()
      .select()
      .from(schema.draftRegenerationHints)
      .where(eq(schema.draftRegenerationHints.draftId, draft.id));
    expect(hint.hintText).toBe('shorter and warmer');

    const [evt] = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id))
      .orderBy(desc(schema.draftEvents.id))
      .limit(1);
    expect(evt.event).toBe('regenerated');
  });

  it('works without a hint and still bumps the counter', async () => {
    const { draft } = await seed();
    const res = await POST({
      params: { id: String(draft.id) },
      request: makeRequest({}),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { regenerationCount: number; hintId: number | null };
    expect(body.regenerationCount).toBe(1);
    expect(body.hintId).toBeNull();
  });
});
