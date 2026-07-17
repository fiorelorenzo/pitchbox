import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { encrypt } from '@pitchbox/shared/crypto';
import { getReplyReader, resolveMastodonClient } from '../src/reply-readers.js';

// Exercises the REAL wiring end to end: an `accounts` row (instanceUrl +
// encrypted access token) -> resolveMastodonClient (DB lookup + decrypt,
// MAS-1) -> a MastodonClient that authenticates its requests with the
// decrypted token -> MastodonReplyReader.readReplies. Only `fetch` is
// mocked (no live network); nothing here bypasses the resolver.

const ENCRYPTION_KEY = 'e'.repeat(64);
const originalFetch = globalThis.fetch;

async function reset() {
  await getDb().execute(sql`TRUNCATE accounts, projects RESTART IDENTITY CASCADE`);
}

async function mastodonPlatformId(): Promise<number> {
  const [row] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'mastodon'));
  return row.id;
}

async function seedProject(): Promise<number> {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'rrm-test', name: 'rrm-test' })
    .returning();
  return proj.id;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  await reset();
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await getPool().end();
});

describe('resolveMastodonClient', () => {
  it('looks up the account by handle, decrypts its token, and builds a working client', async () => {
    const platformId = await mastodonPlatformId();
    const projectId = await seedProject();
    await getDb()
      .insert(schema.accounts)
      .values({
        projectId,
        platformId,
        handle: 'bot@mastodon.example',
        instanceUrl: 'https://mastodon.example',
        accessTokenEncrypted: encrypt('the-real-token', ENCRYPTION_KEY),
      });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = await resolveMastodonClient('bot@mastodon.example');
    await client.notifications({ types: ['mention'] });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://mastodon.example/api/v1/notifications'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer the-real-token' }),
      }),
    );
  });

  it('throws a clear error when no account matches the handle', async () => {
    await expect(resolveMastodonClient('nobody@mastodon.example')).rejects.toThrow(
      'no Mastodon account found',
    );
  });

  it('throws a clear error when ENCRYPTION_KEY is not set', async () => {
    const platformId = await mastodonPlatformId();
    const projectId = await seedProject();
    await getDb()
      .insert(schema.accounts)
      .values({
        projectId,
        platformId,
        handle: 'bot@mastodon.example',
        instanceUrl: 'https://mastodon.example',
        accessTokenEncrypted: encrypt('tok', ENCRYPTION_KEY),
      });
    delete process.env.ENCRYPTION_KEY;

    await expect(resolveMastodonClient('bot@mastodon.example')).rejects.toThrow('ENCRYPTION_KEY');
  });
});

describe('MastodonReplyReader wired to the real resolver', () => {
  it('reads mentions for a real per-account client resolved from the accounts table', async () => {
    const platformId = await mastodonPlatformId();
    const projectId = await seedProject();
    await getDb()
      .insert(schema.accounts)
      .values({
        projectId,
        platformId,
        handle: 'bot@mastodon.example',
        instanceUrl: 'https://mastodon.example',
        accessTokenEncrypted: encrypt('the-real-token', ENCRYPTION_KEY),
      });

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          id: '5000',
          type: 'mention',
          created_at: '2026-07-16T00:00:00.000Z',
          account: { acct: 'someone@elsewhere.example' },
          status: { content: '<p>@bot hi</p>' },
        },
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const reader = getReplyReader('mastodon')!;
    const replies = await reader.readReplies({
      accountHandle: 'bot@mastodon.example',
      since: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(replies).toEqual([
      {
        targetUser: 'someone@elsewhere.example',
        at: new Date('2026-07-16T00:00:00.000Z'),
        preview: '<p>@bot hi</p>',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://mastodon.example/api/v1/notifications'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer the-real-token' }),
      }),
    );
  });
});
