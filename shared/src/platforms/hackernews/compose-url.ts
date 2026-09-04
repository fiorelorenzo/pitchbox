import type { DraftKind } from '../../quota-types.js';
import { replyUrl, submitUrl } from './client.js';

export interface HackernewsComposeUrlInput {
  kind: DraftKind;
  metadata: Record<string, unknown>;
}

/**
 * Builds the Hacker News compose URL server-side (issue #325). HN's submit
 * form and reply page don't accept query-string prefill for title/body, so
 * there is nothing to percent-encode here - only the story id (for a reply)
 * needs to come from somewhere, and it is already on `metadata.itemId`
 * (every hn-commenter draft carries it).
 */
export function buildHackernewsComposeUrl(input: HackernewsComposeUrlInput): string | null {
  switch (input.kind) {
    case 'post':
      return submitUrl();
    case 'post_comment':
    case 'comment_reply': {
      const raw = input.metadata.itemId;
      const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(id) ? replyUrl(id) : null;
    }
    case 'dm':
      // HN has no DM primitive.
      return null;
    default: {
      const exhaustive: never = input.kind;
      return exhaustive;
    }
  }
}
