import type { Reply, ReplyReader, ReplyReaderQuery } from '../base-reply-reader.js';
import type { MastodonClient } from './client.js';

/**
 * Resolves the `MastodonClient` to use for a given account handle. Kept as
 * an injectable factory (rather than a single client) so this reader stays
 * decoupled from how/where account credentials are stored - the daemon can
 * swap in a real per-account resolver once account credentials land, and
 * tests can inject a mock client directly.
 */
export type MastodonClientResolver = (accountHandle: string) => MastodonClient;

/**
 * Server-side reply reader for Mastodon. Unlike Reddit (extension-dependent
 * for replies), Mastodon's REST API lets reply detection run fully
 * server-side: `GET /api/v1/notifications?types[]=mention`.
 *
 * Mastodon paginates notifications by id, not by time, so this reader keeps
 * an in-memory `sinceId` cursor per account handle and passes it on every
 * call so the API only returns notifications newer than the last poll.
 */
export class MastodonReplyReader implements ReplyReader {
  readonly platform = 'mastodon';
  private readonly getClient: MastodonClientResolver;
  private readonly sinceIdByAccount = new Map<string, string>();

  constructor(getClient: MastodonClientResolver) {
    this.getClient = getClient;
  }

  async readReplies({ accountHandle, since }: ReplyReaderQuery): Promise<Reply[]> {
    const client = this.getClient(accountHandle);
    const sinceId = this.sinceIdByAccount.get(accountHandle);
    const notifications = await client.notifications({ sinceId, types: ['mention'] });

    const replies: Reply[] = [];
    let newestId = sinceId;
    for (const notification of notifications) {
      if (newestId === undefined || isNewerId(notification.id, newestId)) {
        newestId = notification.id;
      }
      const at = new Date(notification.created_at);
      if (at < since) continue;
      replies.push({
        targetUser: notification.account.acct,
        at,
        preview: notification.status?.content,
      });
    }

    if (newestId !== undefined) this.sinceIdByAccount.set(accountHandle, newestId);
    return replies;
  }
}

/** Mastodon notification ids are monotonically increasing integers-as-strings. */
function isNewerId(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    return candidate > current;
  }
}
