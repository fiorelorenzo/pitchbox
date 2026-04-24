/**
 * Platform-agnostic interface for reading replies to outreach messages.
 *
 * Implementations read a logged-in account's inbox/notifications and return
 * which target users have replied since a given timestamp. The poller in the
 * daemon uses this without caring about the platform specifics.
 */
export type Reply = {
  targetUser: string;
  at: Date;
  preview?: string;
};

export type ReplyReaderQuery = {
  /** Our account (the one whose inbox we're reading). */
  accountHandle: string;
  /** Only return replies newer than this. */
  since: Date;
};

export interface ReplyReader {
  /** Platform slug this reader belongs to (e.g. "reddit"). */
  readonly platform: string;
  /**
   * Return all replies matching the query. May throw if the account is not
   * logged in or the platform is unreachable — the poller catches and logs.
   */
  readReplies(q: ReplyReaderQuery): Promise<Reply[]>;
}

/**
 * Null implementation: always returns an empty array. Registered as the default
 * until a real platform reader is wired up. Keeps the daemon loop harmless.
 */
export class NullReplyReader implements ReplyReader {
  readonly platform: string;
  constructor(platform: string) {
    this.platform = platform;
  }
  async readReplies(): Promise<Reply[]> {
    return [];
  }
}
