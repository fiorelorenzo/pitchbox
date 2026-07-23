import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as dmSyncPost } from '../src/routes/api/extension/dm-sync/+server.js';
import { GET as dmSyncStatusGet } from '../src/routes/api/extension/dm-sync/status/+server.js';

/**
 * Issue #197: extension_last_dm_sync_at used to be a single global app_config
 * row, so in multi-tenant mode one org's sync overwrote the value every other
 * org read back from /dm-sync/status, and any org's device could read
 * another org's last-sync time. It is now scoped by the authenticated
 * device's organizationId (see dmSyncHeartbeatKey in both route files).
 *
 * Issue #198: the candidate-contact lookup used to fetch every contact_history
 * row for the platform and filter `lastContactedAt >= since` (the 60-day
 * freshness window) in JS. The predicate is now pushed into the SQL WHERE
 * clause so the query scales with the window, not total history.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE messages, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM app_config WHERE key LIKE 'extension_%'`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug LIKE 'dm-sync-liveness-%'`);
}

async function redditPlatformId(): Promise<number> {
  const [platform] = await getDb()
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  return platform.id;
}

async function mintDevice(organizationId: number | null): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await getDb()
    .insert(schema.extensionDevices)
    .values({ label: 'liveness-test device', tokenHash: hashToken(token), organizationId });
  return token;
}

async function seedContact(
  platformId: number,
  accountHandle: string,
  targetUser: string,
  lastContactedAt: Date,
): Promise<void> {
  await getDb().insert(schema.contactHistory).values({
    platformId,
    accountHandle,
    targetUser,
    lastContactedAt,
    draftId: null,
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

function statusRequest(token: string): Request {
  return new Request('http://localhost/api/extension/dm-sync/status', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function callSync(token: string, body: unknown) {
  return dmSyncPost({
    request: syncRequest(token, body),
  } as unknown as Parameters<typeof dmSyncPost>[0]);
}

async function callStatus(token: string): Promise<string | null> {
  const res = await dmSyncStatusGet({
    request: statusRequest(token),
  } as unknown as Parameters<typeof dmSyncStatusGet>[0]);
  const payload = (await res.json()) as { lastSyncAt: string | null };
  return payload.lastSyncAt;
}

beforeEach(reset);

describe('dm-sync liveness heartbeat scoping (#197)', () => {
  it('scopes the last-sync heartbeat per organization instead of one shared value', async () => {
    const db = getDb();
    const platformId = await redditPlatformId();

    const [orgA] = await db
      .insert(schema.organizations)
      .values({ slug: 'dm-sync-liveness-a', name: 'liveness a' })
      .returning();
    const [orgB] = await db
      .insert(schema.organizations)
      .values({ slug: 'dm-sync-liveness-b', name: 'liveness b' })
      .returning();

    const tokenA = await mintDevice(orgA.id);
    const tokenB = await mintDevice(orgB.id);

    await seedContact(
      platformId,
      'org_a_us',
      'org_a_target',
      new Date(Date.now() - 60 * 60 * 1000),
    );
    await seedContact(
      platformId,
      'org_b_us',
      'org_b_target',
      new Date(Date.now() - 60 * 60 * 1000),
    );

    const resA = await callSync(tokenA, {
      platform: 'reddit',
      items: [
        {
          fromUser: 'org_a_target',
          toUser: 'org_a_us',
          body: 'reply for org a',
          threadId: 'org-a-thread',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(resA.status).toBe(200);

    const lastSyncA = await callStatus(tokenA);
    expect(lastSyncA).not.toBeNull();

    // Org B has not synced yet: it must not see org A's last-sync time
    // (the cross-tenant read leak from #197).
    expect(await callStatus(tokenB)).toBeNull();

    const resB = await callSync(tokenB, {
      platform: 'reddit',
      items: [
        {
          fromUser: 'org_b_target',
          toUser: 'org_b_us',
          body: 'reply for org b',
          threadId: 'org-b-thread',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(resB.status).toBe(200);

    const lastSyncB = await callStatus(tokenB);
    expect(lastSyncB).not.toBeNull();

    // Org A's own heartbeat must be untouched by org B's later sync (the
    // cross-tenant write leak from #197: both used to share one row).
    expect(await callStatus(tokenA)).toBe(lastSyncA);

    const [rowA] = await db
      .select()
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, `extension_last_dm_sync_at:org:${orgA.id}`));
    const [rowB] = await db
      .select()
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, `extension_last_dm_sync_at:org:${orgB.id}`));
    expect(rowA?.value).toBe(lastSyncA);
    expect(rowB?.value).toBe(lastSyncB);
  });

  it('keeps the single global key for a self-hosted (null-org) device', async () => {
    const platformId = await redditPlatformId();
    const token = await mintDevice(null);
    await seedContact(
      platformId,
      'self_host_us',
      'self_host_target',
      new Date(Date.now() - 60 * 60 * 1000),
    );

    expect(await callStatus(token)).toBeNull();

    const res = await callSync(token, {
      platform: 'reddit',
      items: [
        {
          fromUser: 'self_host_target',
          toUser: 'self_host_us',
          body: 'reply',
          threadId: 'self-host-thread',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(res.status).toBe(200);

    const lastSync = await callStatus(token);
    expect(lastSync).not.toBeNull();

    const [row] = await getDb()
      .select()
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, 'extension_last_dm_sync_at'));
    expect(row?.value).toBe(lastSync);
  });
});

describe('dm-sync freshness window pushed into SQL (#198)', () => {
  it('filters stale contacts (outside the 60-day window) in SQL, not just in JS', async () => {
    const db = getDb();
    const platformId = await redditPlatformId();
    const token = await mintDevice(null);

    // Fresh contact: inside the 60-day window, should match.
    await seedContact(
      platformId,
      'freshness_us',
      'fresh_target',
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    // Stale contact: well outside the 60-day window, must be filtered out.
    await seedContact(
      platformId,
      'freshness_us',
      'stale_target',
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    );

    const pool = getPool();
    const originalQuery = pool.query.bind(pool);
    const calls: { text: string; params: unknown[] }[] = [];
    (pool as any).query = (...args: any[]) => {
      const [arg0, arg1] = args;
      const text = typeof arg0 === 'string' ? arg0 : (arg0?.text ?? '');
      const params = Array.isArray(arg1) ? arg1 : (arg0?.values ?? []);
      calls.push({ text, params });
      return originalQuery(...(args as Parameters<typeof originalQuery>));
    };

    try {
      const res = await callSync(token, {
        platform: 'reddit',
        items: [
          {
            fromUser: 'fresh_target',
            toUser: 'freshness_us',
            body: 'reply from fresh contact',
            threadId: 'fresh-thread',
            createdAt: new Date().toISOString(),
          },
          {
            fromUser: 'stale_target',
            toUser: 'freshness_us',
            body: 'reply from stale contact',
            threadId: 'stale-thread',
            createdAt: new Date().toISOString(),
          },
        ],
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { inserted: number };
      // Only the fresh contact's DM can match - the stale one is outside the
      // freshness window and must never reach the matcher as a candidate.
      expect(payload.inserted).toBe(1);

      const insertedIds = (
        await db
          .select({ platformMessageId: schema.messages.platformMessageId })
          .from(schema.messages)
      ).map((m) => m.platformMessageId);
      expect(insertedIds).toContain('fresh-thread');
      expect(insertedIds).not.toContain('stale-thread');

      // The candidate lookup itself must carry the freshness predicate in
      // SQL (a "last_contacted_at" comparison in the WHERE clause), not just
      // fetch every row for the platform and filter in JS afterwards.
      const lookupCall = calls.find(
        (c) => c.text.includes('from "contact_history"') && c.text.includes('"last_contacted_at"'),
      );
      expect(lookupCall).toBeDefined();
      expect(lookupCall!.text).toMatch(/"last_contacted_at"\s*>=/);
    } finally {
      pool.query = originalQuery;
    }
  });
});

afterAll(async () => {
  await getPool().end();
});
