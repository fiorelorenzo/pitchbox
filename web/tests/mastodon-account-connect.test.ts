import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { decrypt } from '@pitchbox/shared/crypto';
import { POST } from '../src/routes/api/projects/[id]/accounts/mastodon/+server.js';

const ENCRYPTION_KEY = 'f'.repeat(64);
const originalFetch = globalThis.fetch;
const originalKey = process.env.ENCRYPTION_KEY;

function orgLocalsEvent(
  orgId: number,
  body: unknown,
  params: Record<string, string>,
): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'admin' } },
    params,
    request: { json: async () => body },
  } as unknown as RequestEvent;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function reset() {
  await getDb().execute(sql`TRUNCATE accounts, projects RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedProject(): Promise<{ projectId: number; orgId: number }> {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'mac-test', name: 'mac-test' })
    .returning();
  return { projectId: proj.id, orgId: org.id };
}

beforeEach(async () => {
  await reset();
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  process.env.ENCRYPTION_KEY = originalKey;
  await getPool().end();
});

describe('POST /api/projects/[id]/accounts/mastodon', () => {
  it('validates the token against the instance, stores it encrypted, and derives @user@instance', async () => {
    const { projectId, orgId } = await seedProject();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: '1', username: 'alice', acct: 'alice' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      orgLocalsEvent(
        orgId,
        { instanceUrl: 'https://mastodon.example', accessToken: 'plain-token' },
        { id: String(projectId) },
      ),
    );
    expect(res.status).toBe(201);
    const { account } = (await res.json()) as { account: { id: number; handle: string } };
    expect(account.handle).toBe('@alice@mastodon.example');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mastodon.example/api/v1/accounts/verify_credentials',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer plain-token' }),
      }),
    );

    const [row] = await getDb()
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id));
    expect(row.instanceUrl).toBe('https://mastodon.example');
    expect(row.accessTokenEncrypted).not.toBe('plain-token');
    expect(row.accessTokenEncrypted).not.toContain('plain-token');
    expect(decrypt(row.accessTokenEncrypted!, ENCRYPTION_KEY)).toBe('plain-token');
  });

  it('rejects an invalid token and persists nothing', async () => {
    const { projectId, orgId } = await seedProject();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      orgLocalsEvent(
        orgId,
        { instanceUrl: 'https://mastodon.example', accessToken: 'bad-token' },
        { id: String(projectId) },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');

    const rows = await getDb().select().from(schema.accounts);
    expect(rows).toHaveLength(0);
  });

  it('rejects a malformed body without calling the instance at all', async () => {
    const { projectId, orgId } = await seedProject();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      orgLocalsEvent(
        orgId,
        { instanceUrl: 'not-a-url', accessToken: '' },
        { id: String(projectId) },
      ),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
