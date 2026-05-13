import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as bulkApprove } from '../src/routes/api/drafts/bulk-approve/+server.js';
import { POST as bulkReschedule } from '../src/routes/api/drafts/bulk-reschedule/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function seedMany() {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'bulk-test', name: 'bulk-test' })
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

  const states = ['pending_review', 'pending_review', 'approved', 'sent'];
  const inserted = await db
    .insert(schema.drafts)
    .values(
      states.map((s, i) => ({
        runId: run.id,
        projectId: proj.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        body: `body ${i}`,
        targetUser: `user${i}`,
        state: s,
      })),
    )
    .returning({ id: schema.drafts.id, state: schema.drafts.state });
  return inserted;
}

function makeRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/drafts/bulk-approve', () => {
  beforeEach(reset);

  it('returns per-id outcomes - eligible drafts approved, others skipped', async () => {
    const drafts = await seedMany();
    const ids = drafts.map((d) => d.id);
    const res = await bulkApprove({
      request: makeRequest('/api/drafts/bulk-approve', { ids }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ id: number; status: 'ok' | 'skipped'; reason?: string }>;
    };
    // Two pending_review become ok, approved + sent get skipped.
    const okIds = body.results.filter((r) => r.status === 'ok').map((r) => r.id);
    const skippedIds = body.results.filter((r) => r.status === 'skipped').map((r) => r.id);
    expect(okIds.length).toBe(2);
    expect(skippedIds.length).toBe(2);

    const fresh = await getDb()
      .select()
      .from(schema.drafts)
      .where(inArray(schema.drafts.id, okIds));
    for (const d of fresh) {
      expect(d.state).toBe('approved');
    }
  });
});

describe('POST /api/drafts/bulk-reschedule', () => {
  beforeEach(reset);

  it('sets scheduled_send_after on eligible drafts', async () => {
    const drafts = await seedMany();
    const ids = drafts.map((d) => d.id);
    const sendAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await bulkReschedule({
      request: makeRequest('/api/drafts/bulk-reschedule', { ids, send_after: sendAfter }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ id: number; status: 'ok' | 'skipped'; reason?: string }>;
    };
    // pending_review (2) + approved (1) are eligible; sent (1) is skipped.
    expect(body.results.filter((r) => r.status === 'ok').length).toBe(3);
    expect(body.results.filter((r) => r.status === 'skipped').length).toBe(1);
  });
});
