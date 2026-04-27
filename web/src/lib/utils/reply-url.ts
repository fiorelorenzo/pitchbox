export type ReplyTarget = {
  draftKind: string | null;
  targetUser: string;
  chatRoomId: string | null;
  platformContextUrl: string | null;
};

/**
 * Pick the right Reddit deep link to "reply" to a contact from the dashboard.
 * - DM (`dm`): chat room URL when known, else the user profile (with a Chat button).
 * - Comment (`post_comment`): the permalink path to their reply in the thread.
 * - Anything else: the user profile, as a safe default.
 */
export function replyUrl(t: ReplyTarget): string {
  if (t.draftKind === 'post_comment' && t.platformContextUrl) {
    return `https://www.reddit.com${t.platformContextUrl}`;
  }
  if (t.draftKind === 'dm' && t.chatRoomId) {
    return `https://www.reddit.com/chat/room/${encodeURIComponent(t.chatRoomId)}`;
  }
  return `https://www.reddit.com/user/${t.targetUser}/`;
}
