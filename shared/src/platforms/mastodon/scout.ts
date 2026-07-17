import type { MastodonClient } from './client.js';
import type { MastodonAccount, MastodonStatus } from './types.js';

/** Statuses older than this are dropped as stale when `maxAgeHours` is not set. */
const DEFAULT_MAX_AGE_HOURS = 72;

export interface MastodonScoutCandidate {
  author: {
    acct: string;
    displayName: string;
    url: string;
    note: string;
    followersCount: number;
    createdAt: string;
  };
  status: {
    id: string;
    url: string | null;
    content: string;
    createdAt: string;
    tags: string[];
  };
  /** Hashtag (without the leading "#") whose timeline surfaced this candidate. */
  matchedHashtag: string;
  /** Keyword that matched, when `keywords` filtering is in effect; null otherwise. */
  matchedKeyword: string | null;
}

export interface RunScoutOptions {
  client: MastodonClient;
  /** Hashtags to scan (leading "#" optional, stripped by the client). */
  hashtags: string[];
  /** When set, only statuses whose content matches at least one keyword are kept. */
  keywords?: string[];
  /** Cap on statuses read per hashtag timeline. */
  perTagLimit?: number;
  /** Cursor: only statuses newer than this id are considered, per hashtag. */
  sinceId?: string;
  /** Statuses older than this are dropped as stale. Default 72h. */
  maxAgeHours?: number;
  /** Handles (case-insensitive `acct`) already contacted; skipped. */
  contactedHandles: Set<string>;
  /** Handles (case-insensitive `acct`) on the blocklist; skipped. */
  blockedHandles: Set<string>;
  /** Keywords on the blocklist; a status whose content contains one is skipped. */
  blockedKeywords?: Set<string>;
  /** Injectable clock for deterministic recency tests. Defaults to now. */
  now?: Date;
}

/** Strip HTML tags Mastodon wraps status content in, leaving plain text for matching. */
function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

/**
 * The Mastodon "#nobot" hard rule: skip any author whose bio note or profile
 * fields mention "#nobot" / "nobot". This is a non-configurable skip, not a
 * blocklist entry - it always applies, per the platform's outreach etiquette.
 */
export function isNobotAuthor(account: MastodonAccount): boolean {
  const haystacks = [account.note, ...account.fields.flatMap((f) => [f.name, f.value])];
  return haystacks.some((text) => /#?nobot/i.test(plainText(text)));
}

function isStale(status: MastodonStatus, now: Date, maxAgeHours: number): boolean {
  const createdMs = Date.parse(status.created_at);
  if (!Number.isFinite(createdMs)) return true;
  return now.getTime() - createdMs > maxAgeHours * 60 * 60 * 1000;
}

/** Returns the first keyword found in `content`, or null when none (or no keywords given) match. */
function firstMatchingKeyword(content: string, keywords: string[] | undefined): string | null {
  if (!keywords?.length) return null;
  const lower = content.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

/**
 * Target discovery via hashtag timelines: Mastodon has no reliable
 * full-text search, so candidates are gathered by scanning each hashtag's
 * public timeline, then filtered by the `#nobot` hard rule, the blocklist,
 * recency, contact history, and (when given) keyword relevance.
 */
export async function runScout(opts: RunScoutOptions): Promise<MastodonScoutCandidate[]> {
  const now = opts.now ?? new Date();
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const contacted = new Set([...opts.contactedHandles].map((h) => h.toLowerCase()));
  const blockedHandles = new Set([...opts.blockedHandles].map((h) => h.toLowerCase()));
  const blockedKeywords = [...(opts.blockedKeywords ?? [])];

  const seen = new Set<string>();
  const candidates: MastodonScoutCandidate[] = [];

  for (const tag of opts.hashtags) {
    const statuses = await opts.client.hashtagTimeline(tag, opts.sinceId);
    const limited = opts.perTagLimit != null ? statuses.slice(0, opts.perTagLimit) : statuses;

    for (const status of limited) {
      if (seen.has(status.id)) continue;
      seen.add(status.id);

      if (isStale(status, now, maxAgeHours)) continue;
      if (isNobotAuthor(status.account)) continue;

      const handle = status.account.acct.toLowerCase();
      if (contacted.has(handle)) continue;
      if (blockedHandles.has(handle)) continue;

      const content = plainText(status.content);
      if (firstMatchingKeyword(content, blockedKeywords)) continue;

      const matchedKeyword = firstMatchingKeyword(content, opts.keywords);
      if (opts.keywords?.length && !matchedKeyword) continue;

      candidates.push({
        author: {
          acct: status.account.acct,
          displayName: status.account.display_name,
          url: status.account.url,
          note: status.account.note,
          followersCount: status.account.followers_count,
          createdAt: status.account.created_at,
        },
        status: {
          id: status.id,
          url: status.url,
          content: status.content,
          createdAt: status.created_at,
          tags: status.tags.map((t) => t.name),
        },
        matchedHashtag: tag.replace(/^#/, ''),
        matchedKeyword,
      });
    }
  }

  return candidates;
}
