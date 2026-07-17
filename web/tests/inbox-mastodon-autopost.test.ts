import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { encrypt } from '@pitchbox/shared/crypto';
import { PATCH } from '../src/routes/inbox/[id]/+server.js';

// Covers MAS-5's auto-post-on-approve path: a draft on a mastodon campaign
// with campaigns.auto_post = true is posted via the (mocked) Mastodon API the
// moment it is approved, storing platform_post_id, flipping straight to
// `sent`, and logging contact_history - guarded by the real evaluateDraftSend
// (blocklist + quota) exactly like manual send. A manual (auto_post = false)
// mastodon campaign keeps today's human-in-the-loop behavior: approve just
// approves, nothing is posted.

const ENCRYPTION_KEY = 'b'.repeat(64);
const originalFetch = globalThis.fetch;
const originalKey = process.env.ENCRYPTION_KEY;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
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

async function seed(opts: {
  autoPost: boolean;
  kind?: 'dm' | 'post' | 'post_comment';
  targetUser?: string | null;
  platformCommentId?: string | null;
}) {
  const db = getDb();
  const platformId = await mastodonPlatformId();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'mastodon-autopost-test', name: 'mastodon-autopost' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: proj.id,
      platformId,
      handle: '@bot@mastodon.example',
      role: 'brand',
      instanceUrl: 'https://mastodon.example',
      accessTokenEncrypted: encrypt('test-token', ENCRYPTION_KEY),
      isDefault: true,
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId,
      name: 'Mastodon Poster',
      skillSlug: 'mastodon-poster',
      autoPost: opts.autoPost,
    })
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
      platformId,
      accountId: account.id,
      kind: opts.kind ?? 'post',
      body: 'Launching a self-hosted outreach agent for Reddit and HN.',
      targetUser: opts.targetUser === undefined ? null : opts.targetUser,
      platformCommentId: opts.platformCommentId ?? null,
      state: 'pending_review',
    })
    .returning();
  return { org, proj, platformId, account, campaign, run, draft };
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

beforeEach(async () => {
  await reset();
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.ENCRYPTION_KEY = originalKey;
});

describe('PATCH /inbox/[id] mastodon auto-post on approve', () => {
  it('posts via the API, stores platform_post_id, flips to sent, and logs contact_history', async () => {
    const db = getDb();
    const { draft, platformId, account } = await seed({
      autoPost: true,
      kind: 'post',
      targetUser: null,
    });

    const fetchMock = vi.fn(
      async (
        url: string | URL,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        expect(String(url)).toBe('https://mastodon.example/api/v1/statuses');
        const reqBody = JSON.parse(String(init?.body));
        expect(reqBody.visibility).toBe('public');
        return new Response(
          JSON.stringify({
            id: '555',
            uri: 'x',
            url: 'https://mastodon.example/@bot/555',
            created_at: new Date().toISOString(),
            in_reply_to_id: null,
            in_reply_to_account_id: null,
            content: reqBody.status,
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(fresh.state).toBe('sent');
    expect(fresh.platformPostId).toBe('555');
    expect(fresh.sentAt).toBeTruthy();

    const events = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id));
    expect(events.map((e) => e.event)).toEqual(['approved', 'sent']);
    expect(events[1].actor).toBe('system');

    // No targetUser on this draft, so no contact_history row is expected.
    const contacted = await db
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.platformId, platformId));
    expect(contacted).toHaveLength(0);
    void account;
  });

  it('records contact_history when the draft has a targetUser', async () => {
    const db = getDb();
    const { draft, account } = await seed({
      autoPost: true,
      kind: 'dm',
      targetUser: 'alice@fosstodon.org',
    });

    globalThis.fetch = (async (
      _url: string | URL,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const reqBody = JSON.parse(String(init?.body));
      expect(reqBody.visibility).toBe('direct');
      expect(reqBody.status).toContain('@alice@fosstodon.org');
      return new Response(
        JSON.stringify({
          id: '556',
          uri: 'x',
          url: null,
          created_at: new Date().toISOString(),
          in_reply_to_id: null,
          in_reply_to_account_id: null,
          content: reqBody.status,
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
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const res = await PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version }));
    expect(res.status).toBe(200);

    const contacted = await db
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draft.id));
    expect(contacted).toHaveLength(1);
    expect(contacted[0].targetUser).toBe('alice@fosstodon.org');
    expect(contacted[0].accountHandle).toBe(account.handle);
  });

  it('does not post and leaves the draft merely approved on a non-auto-post mastodon campaign', async () => {
    const db = getDb();
    const { draft } = await seed({ autoPost: false, kind: 'post' });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(fresh.state).toBe('approved');
    expect(fresh.platformPostId).toBeNull();
  });

  it('blocks the approve (nothing posted) when the target is blocklisted', async () => {
    const db = getDb();
    const { draft, platformId } = await seed({
      autoPost: true,
      kind: 'dm',
      targetUser: 'spammer',
    });
    await db
      .insert(schema.blocklist)
      .values({ platformId, kind: 'user', value: 'spammer', reason: 'known spammer' });

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version })),
    ).rejects.toMatchObject({ status: 409, body: { message: 'blocklisted: known spammer' } });
    expect(fetchMock).not.toHaveBeenCalled();

    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(fresh.state).toBe('pending_review');
  });

  it('blocks the approve when the mastodon post quota would be breached', async () => {
    const db = getDb();
    const { draft, platformId, account, run, proj } = await seed({
      autoPost: true,
      kind: 'post',
    });
    await db
      .update(schema.accounts)
      .set({ dailyLimit: 2 })
      .where(eq(schema.accounts.id, account.id));
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.drafts).values({
        runId: run.id,
        projectId: proj.id,
        platformId,
        accountId: account.id,
        kind: 'post',
        state: 'sent',
        body: 'x',
        sentAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
      });
    }

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version })),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a post_comment draft to a public reply using platform_comment_id', async () => {
    const db = getDb();
    const { draft } = await seed({
      autoPost: true,
      kind: 'post_comment',
      targetUser: 'bob@fosstodon.org',
      platformCommentId: '778899',
    });

    const fetchMock = vi.fn(
      async (
        _url: string | URL,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        const reqBody = JSON.parse(String(init?.body));
        expect(reqBody.visibility).toBe('public');
        expect(reqBody.in_reply_to_id).toBe('778899');
        return new Response(
          JSON.stringify({
            id: '557',
            uri: 'x',
            url: null,
            created_at: new Date().toISOString(),
            in_reply_to_id: '778899',
            in_reply_to_account_id: null,
            content: reqBody.status,
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await PATCH(patchEvent(draft.id, { state: 'approved', version: draft.version }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [fresh] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(fresh.platformPostId).toBe('557');
  });
});
