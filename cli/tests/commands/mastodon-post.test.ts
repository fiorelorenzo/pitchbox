import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getDb, schema } from '@pitchbox/shared/db';
import { encrypt } from '@pitchbox/shared/crypto';
import { eq, sql } from 'drizzle-orm';

// postRun (the mcp__pitchbox__mastodon_post tool) is the auto-post path
// (MAS-5/MAS-7): it gates on campaign.autoPost, runs the draft through the
// REAL evaluateDraftSend (blocklist + quota, exercised against Postgres, not
// faked), and on success calls the real MastodonClient.postStatus (network
// mocked via global fetch) before persisting an already-sent draft row +
// draftEvents + contactHistory. This never touches the network for anything
// but the final postStatus call.

const ENCRYPTION_KEY = 'e'.repeat(64);
const originalFetch = globalThis.fetch;
const originalKey = process.env.ENCRYPTION_KEY;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function mastodonPlatformId(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .insert(schema.platforms)
    .values({ slug: 'mastodon' })
    .onConflictDoNothing()
    .returning();
  if (row) return row.id;
  const [existing] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'mastodon'));
  return existing.id;
}

async function seedRun(opts: { autoPost: boolean; withAccount?: boolean }) {
  const db = getDb();
  const platformId = await mastodonPlatformId();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'mastodon-post-test', name: 'Mastodon Post Test' })
    .returning();
  let accountId: number | null = null;
  let handle = '@bot@mastodon.example';
  if (opts.withAccount !== false) {
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId,
        handle,
        role: 'brand',
        instanceUrl: 'https://mastodon.example',
        accessTokenEncrypted: encrypt('test-token', ENCRYPTION_KEY),
        isDefault: true,
      })
      .returning();
    accountId = account.id;
  } else {
    handle = '';
  }
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId,
      name: 'Mastodon Poster',
      skillSlug: 'mastodon-poster',
      autoPost: opts.autoPost,
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, projectId: project.id, trigger: 'manual' })
    .returning();
  return {
    platformId,
    projectId: project.id,
    campaignId: campaign.id,
    runId: run.id,
    accountId,
    handle,
  };
}

beforeEach(async () => {
  await reset();
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.ENCRYPTION_KEY = originalKey;
});

describe('mastodon postRun', () => {
  it('throws when the campaign does not have auto_post enabled', async () => {
    const { runId } = await seedRun({ autoPost: false });
    const { postRun } = await import('../../src/commands/mastodon.js');
    await expect(postRun(runId, { kind: 'post', status: 'hello world' })).rejects.toThrow(
      'does not have auto_post enabled',
    );
  });

  it('throws when kind is "dm" and no targetHandle is given', async () => {
    const { runId } = await seedRun({ autoPost: true });
    const { postRun } = await import('../../src/commands/mastodon.js');
    await expect(postRun(runId, { kind: 'dm', status: 'hi' })).rejects.toThrow('targetHandle');
  });

  it('throws when kind is "comment" and no inReplyToId is given', async () => {
    const { runId } = await seedRun({ autoPost: true });
    const { postRun } = await import('../../src/commands/mastodon.js');
    await expect(postRun(runId, { kind: 'comment', status: 'hi' })).rejects.toThrow('inReplyToId');
  });

  it('posts a public status, persists an already-sent draft, and logs contact_history', async () => {
    const db = getDb();
    const { runId, platformId, accountId, handle } = await seedRun({ autoPost: true });

    const fetchMock = vi.fn(
      async (
        url: string | URL,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        expect(String(url)).toBe('https://mastodon.example/api/v1/statuses');
        const body = JSON.parse(String(init?.body));
        expect(body.status).toContain('@alice@fosstodon.org');
        expect(body.visibility).toBe('direct');
        return jsonResponse({
          id: '999',
          uri: 'x',
          url: 'https://mastodon.example/@bot/999',
          created_at: new Date().toISOString(),
          in_reply_to_id: null,
          in_reply_to_account_id: null,
          content: body.status,
          visibility: 'direct',
          sensitive: false,
          spoiler_text: '',
          account: {},
          mentions: [],
          tags: [],
          replies_count: 0,
          reblogs_count: 0,
          favourites_count: 0,
          reblog: null,
        });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { postRun } = await import('../../src/commands/mastodon.js');
    const result = await postRun(runId, {
      kind: 'dm',
      status: 'Loved your recent post about self-hosting.',
      targetHandle: 'alice@fosstodon.org',
    });

    expect(result).toEqual({
      runId,
      draftId: expect.any(Number),
      platformPostId: '999',
      url: 'https://mastodon.example/@bot/999',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, result.draftId));
    expect(draft.state).toBe('sent');
    expect(draft.platformPostId).toBe('999');
    expect(draft.sentAt).toBeTruthy();
    expect(draft.kind).toBe('dm');
    expect(draft.accountId).toBe(accountId);

    const events = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, result.draftId));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('sent');
    expect(events[0].actor).toBe('agent');

    const contacted = await db
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.platformId, platformId));
    expect(contacted).toHaveLength(1);
    expect(contacted[0].targetUser).toBe('alice@fosstodon.org');
    expect(contacted[0].accountHandle).toBe(handle);
    // #215: the contact carries the draft's org so it stays matchable after
    // retention prunes the draft.
    const [defaultOrg] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, 'default'));
    expect(contacted[0].organizationId).toBe(defaultOrg.id);
  });

  it('maps kind "comment" to a public reply using in_reply_to_id', async () => {
    const { runId } = await seedRun({ autoPost: true });

    const fetchMock = vi.fn(
      async (
        _url: string | URL,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        const body = JSON.parse(String(init?.body));
        expect(body.visibility).toBe('public');
        expect(body.in_reply_to_id).toBe('42');
        return jsonResponse({
          id: '1000',
          uri: 'x',
          url: null,
          created_at: new Date().toISOString(),
          in_reply_to_id: '42',
          in_reply_to_account_id: null,
          content: body.status,
          visibility: 'public',
          sensitive: false,
          spoiler_text: '',
          account: {},
          mentions: [],
          tags: [],
          replies_count: 0,
          reblogs_count: 0,
          favourites_count: 0,
          reblog: null,
        });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { postRun } = await import('../../src/commands/mastodon.js');
    const result = await postRun(runId, {
      kind: 'comment',
      status: 'Totally agree with this.',
      inReplyToId: '42',
    });
    expect(result.platformPostId).toBe('1000');
  });

  it('blocks the send (no network call, no draft persisted) when the target is blocklisted', async () => {
    const db = getDb();
    const { runId, platformId } = await seedRun({ autoPost: true });
    await db
      .insert(schema.blocklist)
      .values({ platformId, kind: 'user', value: 'spammer', reason: 'known spammer' });

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { postRun } = await import('../../src/commands/mastodon.js');
    await expect(
      postRun(runId, { kind: 'dm', status: 'hi', targetHandle: 'spammer' }),
    ).rejects.toThrow('blocklisted: known spammer');
    expect(fetchMock).not.toHaveBeenCalled();

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(0);
  });

  it('blocks the send when the mastodon per-day quota would be breached', async () => {
    const db = getDb();
    const { runId, platformId, accountId, campaignId } = await seedRun({ autoPost: true });

    // Conservative mastodon post default is perDay: 3 (seed-core). Seed 3
    // already-sent post drafts in the last 24h so the 4th is over quota.
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.drafts).values({
        runId,
        projectId: (
          await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId))
        )[0].projectId,
        platformId,
        accountId: accountId!,
        kind: 'post',
        state: 'sent',
        body: 'x',
        sentAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
      });
    }
    await db
      .insert(schema.appConfig)
      .values({
        key: 'quota_defaults',
        value: {
          mastodon: {
            dm: { perDay: 5, perWeek: 20 },
            comment: { perDay: 20, perWeek: 80 },
            post: { perDay: 3, perWeek: 10 },
          },
        },
      })
      .onConflictDoUpdate({
        target: schema.appConfig.key,
        set: {
          value: {
            mastodon: {
              dm: { perDay: 5, perWeek: 20 },
              comment: { perDay: 20, perWeek: 80 },
              post: { perDay: 3, perWeek: 10 },
            },
          },
        },
      });

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await db
      .update(schema.accounts)
      .set({ dailyLimit: 3 })
      .where(eq(schema.accounts.id, accountId!));

    const { postRun } = await import('../../src/commands/mastodon.js');
    await expect(postRun(runId, { kind: 'post', status: 'another one' })).rejects.toThrow(
      'quota_exceeded',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
