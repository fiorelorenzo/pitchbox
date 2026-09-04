import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as dmSyncPost } from '../src/routes/api/extension/dm-sync/+server.js';

/**
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
  organizationId: number,
): Promise<void> {
  await getDb().insert(schema.contactHistory).values({
    platformId,
    accountHandle,
    targetUser,
    lastContactedAt,
    draftId: null,
    repliedAt: null,
    organizationId,
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

beforeEach(reset);

describe('dm-sync freshness window pushed into SQL (#198)', () => {
  it('filters stale contacts (outside the 60-day window) in SQL, not just in JS', async () => {
    const db = getDb();
    const platformId = await redditPlatformId();
    const token = await mintDevice(null);
    const [defaultOrg] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);

    await seedContact(
      platformId,
      'freshness_us',
      'fresh_target',
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      defaultOrg.id,
    );
    await seedContact(
      platformId,
      'freshness_us',
      'stale_target',
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      defaultOrg.id,
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
