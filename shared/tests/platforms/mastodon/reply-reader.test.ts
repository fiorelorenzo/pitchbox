import { describe, expect, it, vi } from 'vitest';
import { MastodonReplyReader } from '../../../src/platforms/mastodon/reply-reader.js';
import type { MastodonClient } from '../../../src/platforms/mastodon/client.js';
import type {
  MastodonAccount,
  MastodonNotification,
  MastodonStatus,
} from '../../../src/platforms/mastodon/types.js';

function fakeAccount(overrides: Partial<MastodonAccount> = {}): MastodonAccount {
  return {
    id: '1',
    username: 'alice',
    acct: 'alice@mastodon.example',
    display_name: 'Alice',
    url: 'https://mastodon.example/@alice',
    note: '',
    bot: false,
    locked: false,
    fields: [],
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<MastodonStatus> = {}): MastodonStatus {
  return {
    id: '100',
    uri: 'https://mastodon.example/users/alice/statuses/100',
    url: 'https://mastodon.example/@alice/100',
    created_at: '2026-01-01T00:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    content: '<p>hello</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    account: fakeAccount(),
    mentions: [],
    tags: [],
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    reblog: null,
    ...overrides,
  };
}

function fakeNotification(overrides: Partial<MastodonNotification> = {}): MastodonNotification {
  return {
    id: '1000',
    type: 'mention',
    created_at: '2026-01-02T00:00:00.000Z',
    account: fakeAccount(),
    status: fakeStatus(),
    ...overrides,
  };
}

function fakeClient(notifications: MastodonNotification[]): MastodonClient {
  return {
    notifications: vi.fn().mockResolvedValue(notifications),
  } as unknown as MastodonClient;
}

describe('MastodonReplyReader', () => {
  it('maps mentions since the query time into Reply[]', async () => {
    const notif = fakeNotification({
      id: '2000',
      account: fakeAccount({ acct: 'bob@mastodon.example' }),
      created_at: '2026-01-05T12:00:00.000Z',
      status: fakeStatus({ content: '<p>@pitchbox hi there</p>' }),
    });
    const client = fakeClient([notif]);
    const reader = new MastodonReplyReader(() => client);

    const replies = await reader.readReplies({
      accountHandle: 'me@mastodon.example',
      since: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(replies).toEqual([
      {
        targetUser: 'bob@mastodon.example',
        at: new Date('2026-01-05T12:00:00.000Z'),
        preview: '<p>@pitchbox hi there</p>',
      },
    ]);
  });

  it('requests only mention notifications', async () => {
    const client = fakeClient([]);
    const reader = new MastodonReplyReader(() => client);

    await reader.readReplies({ accountHandle: 'me', since: new Date('2026-01-01T00:00:00.000Z') });

    expect(client.notifications).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['mention'] }),
    );
  });

  it('filters out mentions older than the query "since" timestamp', async () => {
    const stale = fakeNotification({
      id: '1',
      created_at: '2025-12-31T00:00:00.000Z',
      account: fakeAccount({ acct: 'old-user' }),
    });
    const fresh = fakeNotification({
      id: '2',
      created_at: '2026-01-10T00:00:00.000Z',
      account: fakeAccount({ acct: 'new-user' }),
    });
    const client = fakeClient([stale, fresh]);
    const reader = new MastodonReplyReader(() => client);

    const replies = await reader.readReplies({
      accountHandle: 'me',
      since: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(replies.map((r) => r.targetUser)).toEqual(['new-user']);
  });

  it('resolves the client for the queried account handle', async () => {
    const client = fakeClient([]);
    const getClient = vi.fn().mockReturnValue(client);
    const reader = new MastodonReplyReader(getClient);

    await reader.readReplies({
      accountHandle: 'me@mastodon.example',
      since: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(getClient).toHaveBeenCalledWith('me@mastodon.example');
  });

  it('advances the sinceId cursor across calls for the same account', async () => {
    const first = fakeNotification({ id: '10', account: fakeAccount({ acct: 'a' }) });
    const second = fakeNotification({ id: '20', account: fakeAccount({ acct: 'b' }) });
    const client: MastodonClient = {
      notifications: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]),
    } as unknown as MastodonClient;
    const reader = new MastodonReplyReader(() => client);
    const since = new Date('2026-01-01T00:00:00.000Z');

    await reader.readReplies({ accountHandle: 'me', since });
    expect(client.notifications).toHaveBeenNthCalledWith(1, {
      sinceId: undefined,
      types: ['mention'],
    });

    await reader.readReplies({ accountHandle: 'me', since });
    expect(client.notifications).toHaveBeenNthCalledWith(2, { sinceId: '10', types: ['mention'] });
  });

  it('tracks the cursor independently per account', async () => {
    const notifForMe = fakeNotification({ id: '5', account: fakeAccount({ acct: 'x' }) });
    const client: MastodonClient = {
      notifications: vi.fn().mockResolvedValue([notifForMe]),
    } as unknown as MastodonClient;
    const reader = new MastodonReplyReader(() => client);
    const since = new Date('2026-01-01T00:00:00.000Z');

    await reader.readReplies({ accountHandle: 'me', since });
    await reader.readReplies({ accountHandle: 'other', since });

    expect(client.notifications).toHaveBeenNthCalledWith(1, {
      sinceId: undefined,
      types: ['mention'],
    });
    expect(client.notifications).toHaveBeenNthCalledWith(2, {
      sinceId: undefined,
      types: ['mention'],
    });
  });

  it('exposes the platform slug', () => {
    const reader = new MastodonReplyReader(() => fakeClient([]));
    expect(reader.platform).toBe('mastodon');
  });
});
