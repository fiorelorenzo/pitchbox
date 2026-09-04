import type { DraftKind } from '../../quota-types.js';

const BASE = 'https://www.reddit.com';

export interface RedditComposeUrlInput {
  kind: DraftKind;
  targetUser: string | null;
  subreddit: string | null;
  title: string | null;
  body: string;
  // DM subject line, sourced from campaign.config.offer.subject. Only a `dm`
  // draft uses it.
  subject: string | null;
  sourceRef: Record<string, unknown>;
}

/**
 * Builds the Reddit compose URL server-side from the same fields already
 * persisted on the draft (issue #325). `URLSearchParams` owns every bit of
 * percent-encoding, so the query string can never diverge from
 * `drafts.body`/`drafts.title` the way a hand-encoded, agent-supplied URL
 * could.
 */
export function buildRedditComposeUrl(input: RedditComposeUrlInput): string | null {
  switch (input.kind) {
    case 'dm': {
      if (!input.targetUser) return null;
      const params = new URLSearchParams({ to: input.targetUser });
      if (input.subject) params.set('subject', input.subject);
      params.set('message', input.body);
      return `${BASE}/message/compose?${params.toString()}`;
    }
    case 'post': {
      if (!input.subreddit) return null;
      const params = new URLSearchParams();
      if (input.title) params.set('title', input.title);
      params.set('text', input.body);
      return `${BASE}/r/${encodeURIComponent(input.subreddit)}/submit?${params.toString()}`;
    }
    case 'post_comment':
    case 'comment_reply': {
      // A comment reply has no query-string prefill on Reddit; the compose
      // URL is just the permalink of the thread it belongs to.
      const permalink = input.sourceRef.permalink;
      return typeof permalink === 'string' && permalink.length > 0 ? `${BASE}${permalink}` : null;
    }
    default: {
      const exhaustive: never = input.kind;
      return exhaustive;
    }
  }
}
