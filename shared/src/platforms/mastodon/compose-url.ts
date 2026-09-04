import type { DraftKind } from '../../quota-types.js';

export interface MastodonComposeUrlInput {
  kind: DraftKind;
  body: string;
  // The account's instance base URL (e.g. "https://mastodon.social"),
  // read from accounts.instance_url. A `dm`/`post` draft can't build a
  // compose URL without it.
  instanceUrl: string | null;
  sourceRef: Record<string, unknown>;
}

/**
 * Builds the Mastodon compose URL server-side (issue #325). A `dm` (a
 * direct-visibility status mentioning the target - see mastodon-scout.md)
 * and a `post` both open the instance's share intent prefilled with the
 * full body via `URLSearchParams`, so the text in the compose window can
 * never diverge from `drafts.body`. A `post_comment`/`comment_reply` has no
 * prefill on Mastodon; the compose URL is just the target status's own
 * permalink, same as the reddit/HN comment-reply shape.
 */
export function buildMastodonComposeUrl(input: MastodonComposeUrlInput): string | null {
  switch (input.kind) {
    case 'dm':
    case 'post': {
      if (!input.instanceUrl) return null;
      const params = new URLSearchParams({ text: input.body });
      return `${input.instanceUrl}/share?${params.toString()}`;
    }
    case 'post_comment':
    case 'comment_reply': {
      const statusUrl = input.sourceRef.statusUrl;
      return typeof statusUrl === 'string' && statusUrl.length > 0 ? statusUrl : null;
    }
    default: {
      const exhaustive: never = input.kind;
      return exhaustive;
    }
  }
}
