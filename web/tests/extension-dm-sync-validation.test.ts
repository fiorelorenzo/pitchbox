import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as dmSyncPost } from '../src/routes/api/extension/dm-sync/+server.js';

/**
 * Issue #182: the route used to trust a bare type cast on the request body.
 * A malformed item (e.g. missing `createdAt`) produced `new Date(undefined)`
 * (an Invalid Date), which bypassed the staleness check or hit the DB and
 * 500'd; a non-string field threw an unhandled TypeError.
 *
 * The body is now validated with zod. The envelope (platform, array shape,
 * size cap) is a hard 400, but ELEMENTS are validated per-item and malformed
 * ones are DROPPED rather than failing the whole batch: the extension builds
 * items from raw Reddit data with `?? ''` fallbacks, so one degenerate entry
 * must not 400 the batch and wedge the pairing's cursor forever.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
}

async function mintDevice(): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await getDb()
    .insert(schema.extensionDevices)
    .values({ label: 'validation-test device', tokenHash: hashToken(token) });
  return token;
}

async function seedMatchableContact() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'dm-sync-validation', name: 'dm-sync-validation' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId: platform.id, handle: 'us_handle' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'c',
      skillSlug: 'reddit-scout',
    })
    .returning();
  // agentRunner is a made-up slug on purpose: the fire-and-forget
  // reply-drafting dispatch this route kicks off then fails fast on an
  // unknown agent runner instead of spawning a real agent, keeping the test
  // hermetic (see the sibling extension-dm-sync-scope.test.ts).
  const [run] = await db
    .insert(schema.runs)
    .values({
      campaignId: campaign.id,
      trigger: 'manual',
      status: 'success',
      agentRunner: 'test-noop',
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
      body: 'hi there',
      targetUser: 'target_user',
      state: 'sent',
      sentAt: new Date(),
    })
    .returning();
  await db.insert(schema.contactHistory).values({
    platformId: platform.id,
    accountHandle: 'us_handle',
    targetUser: 'target_user',
    lastContactedAt: new Date(Date.now() - 60 * 60 * 1000),
    draftId: draft.id,
    repliedAt: null,
  });
}

function syncRequest(token: string, body: unknown): Request {
  return new Request('http://localhost/api/extension/dm-sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callSync(token: string, body: unknown) {
  return dmSyncPost({
    request: syncRequest(token, body),
  } as unknown as Parameters<typeof dmSyncPost>[0]);
}

async function messageCount(): Promise<number> {
  const rows = await getDb().select({ id: schema.messages.id }).from(schema.messages);
  return rows.length;
}

const validItem = (over: Record<string, unknown> = {}) => ({
  fromUser: 'target_user',
  toUser: 'us_handle',
  body: 'a real reply',
  threadId: 'valid-1',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('POST /api/extension/dm-sync body validation', () => {
  beforeEach(reset);

  it('drops an item missing createdAt instead of failing the batch (no write)', async () => {
    const token = await mintDevice();
    const res = await callSync(token, {
      platform: 'reddit',
      items: [
        { fromUser: 'target_user', toUser: 'us_handle', body: 'a reply', threadId: 'no-date' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await messageCount()).toBe(0);
  });

  it('drops an item with a non-string handle instead of failing the batch', async () => {
    const token = await mintDevice();
    const res = await callSync(token, {
      platform: 'reddit',
      items: [{ fromUser: 12345, toUser: 'us_handle', body: 'x', threadId: 'bad', createdAt: 'z' }],
    });
    expect(res.status).toBe(200);
    expect(await messageCount()).toBe(0);
  });

  it('processes valid items while dropping a malformed one in the same batch (#182)', async () => {
    const token = await mintDevice();
    await seedMatchableContact();
    const res = await callSync(token, {
      platform: 'reddit',
      items: [
        // poison item (no createdAt) - must be dropped, not stall the batch
        { fromUser: 'target_user', toUser: 'us_handle', body: 'poison', threadId: 'poison-1' },
        validItem(),
      ],
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { inserted: number; replied: number };
    expect(payload.inserted).toBe(1);
    expect(await messageCount()).toBe(1);
  });

  it('rejects a structurally invalid body (missing platform / items not an array) with 400', async () => {
    const token = await mintDevice();
    await expect(callSync(token, { items: [] })).rejects.toMatchObject({ status: 400 });
    await expect(callSync(token, { platform: 'reddit', items: 'nope' })).rejects.toMatchObject({
      status: 400,
    });
    expect(await messageCount()).toBe(0);
  });

  it('rejects an oversized items array with 400 and writes nothing', async () => {
    const token = await mintDevice();
    const items = Array.from({ length: 501 }, (_, i) =>
      validItem({ body: `msg ${i}`, threadId: `oversized-${i}` }),
    );
    await expect(callSync(token, { platform: 'reddit', items })).rejects.toMatchObject({
      status: 400,
    });
    expect(await messageCount()).toBe(0);
  });

  it('still inserts and matches a well-formed payload as before', async () => {
    const token = await mintDevice();
    await seedMatchableContact();
    const res = await callSync(token, { platform: 'reddit', items: [validItem()] });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; inserted: number; replied: number };
    expect(payload.inserted).toBe(1);
    expect(payload.replied).toBe(1);
    expect(await messageCount()).toBe(1);
  });
});

afterAll(async () => {
  await getPool().end();
});
