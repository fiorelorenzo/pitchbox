/**
 * Mastodon API shapes (subset actually consumed by Pitchbox). Mirrors the
 * REST entities documented at https://docs.joinmastodon.org/entities/ but
 * only exposes the fields the adapter reads or writes.
 */

export type MastodonVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface MastodonField {
  name: string;
  value: string;
  verified_at: string | null;
}

export interface MastodonAccount {
  id: string;
  username: string;
  /** Fully qualified handle: "user" locally, "user@instance" when remote. */
  acct: string;
  display_name: string;
  url: string;
  note: string;
  bot: boolean;
  locked: boolean;
  fields: MastodonField[];
  followers_count: number;
  following_count: number;
  statuses_count: number;
  created_at: string;
}

export interface MastodonMention {
  id: string;
  username: string;
  acct: string;
  url: string;
}

export interface MastodonTag {
  name: string;
  url: string;
}

export interface MastodonStatus {
  id: string;
  uri: string;
  url: string | null;
  created_at: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  content: string;
  visibility: MastodonVisibility;
  sensitive: boolean;
  spoiler_text: string;
  account: MastodonAccount;
  mentions: MastodonMention[];
  tags: MastodonTag[];
  replies_count: number;
  reblogs_count: number;
  favourites_count: number;
  /** Present when this status is a boost of another one; null otherwise. */
  reblog: MastodonStatus | null;
}

export type MastodonNotificationType =
  | 'mention'
  | 'status'
  | 'reblog'
  | 'follow'
  | 'follow_request'
  | 'favourite'
  | 'poll'
  | 'update'
  | 'admin.sign_up'
  | 'admin.report';

export interface MastodonNotification {
  id: string;
  type: MastodonNotificationType;
  created_at: string;
  account: MastodonAccount;
  status: MastodonStatus | null;
}

export interface MastodonContext {
  ancestors: MastodonStatus[];
  descendants: MastodonStatus[];
}

export interface PostStatusParams {
  status: string;
  /** Id of the status this one replies to (a `comment`-kind draft). */
  inReplyToId?: string;
  /** Defaults to the instance default (usually "public") when omitted. */
  visibility?: MastodonVisibility;
}

export interface NotificationsParams {
  /** Only return notifications newer than this id. */
  sinceId?: string;
  /** Restrict to these notification types (e.g. ["mention"]). */
  types?: MastodonNotificationType[];
}
