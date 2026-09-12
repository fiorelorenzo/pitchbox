import {
  acquireBrowser,
  browseSubreddit,
  closeBrowser,
  getUserAbout,
  searchPosts,
  profileUrl,
} from './reddit.js';
import { loadEnv } from './env.js';
import { DEFAULT_MAX_POST_AGE_HOURS, filterCandidates } from './filter.js';
import type { ScoutCandidate, ScoutProfile, Timeframe } from './types.js';

export interface RunScoutOptions {
  profile: ScoutProfile;
  contactedHandles: Set<string>;
  blockedHandles: Set<string>;
  verbose?: boolean;
  /** Injectable clock for deterministic recency tests. Defaults to now. */
  now?: Date;
}

export interface RunScoutResult {
  candidates: ScoutCandidate[];
  /** Count of candidates dropped for being older than the campaign's recency cap (#338). */
  droppedByAge: number;
}

/**
 * The search window Reddit is asked for, derived from the recency cap the
 * candidates are then filtered against (`DEFAULT_MAX_POST_AGE_HOURS` when
 * the campaign sets none). The scout used to always ask for a month while
 * dropping anything older than 72 hours, so a relevance-sorted page of 20
 * results spent almost its whole budget on posts the filter would discard.
 */
function searchTimeframe(maxPostAgeHours: number | null | undefined): Timeframe {
  const hours = maxPostAgeHours ?? DEFAULT_MAX_POST_AGE_HOURS;
  if (hours <= 24) return 'day';
  if (hours <= 24 * 7) return 'week';
  if (hours <= 24 * 31) return 'month';
  return 'year';
}

export async function runScout(opts: RunScoutOptions): Promise<RunScoutResult> {
  const env = loadEnv();
  // Claim the shared browser/context before scraping and release it in the
  // finally below. The client process can multiplex concurrent runs (e.g.
  // the cloud runner relaying several sessions), so closeBrowser() only
  // actually tears the browser down once every claim has been released -
  // this run's cleanup must not close a browser a sibling run still needs.
  acquireBrowser();
  try {
    const raw: ScoutCandidate[] = [];
    const seen = new Set<string>();

    for (const subreddit of opts.profile.targetSubreddits) {
      const queries = opts.profile.topicKeywords?.length ? opts.profile.topicKeywords : [''];
      for (const query of queries) {
        const posts = await searchPosts(env, {
          query,
          subreddit,
          sort: 'relevance',
          timeframe: searchTimeframe(opts.profile.maxPostAgeHours),
          limit: opts.profile.perSubredditLimit ?? 20,
        });
        for (const post of posts) {
          if (post.subreddit.toLowerCase() !== subreddit.toLowerCase()) continue;
          if (seen.has(post.id)) continue;
          seen.add(post.id);
          const user = await getUserAbout(env, post.author);
          if (!user) continue;
          raw.push({
            user: {
              name: user.name,
              karma: user.totalKarma,
              createdUtc: user.createdUtc,
            },
            post: {
              title: post.title,
              selftext: post.selftext,
              permalink: post.permalink,
              score: post.score,
              subreddit: post.subreddit,
              numComments: post.numComments,
              createdUtc: post.createdUtc,
            },
            profileUrl: profileUrl(user.name),
            composeUrlBase: `https://www.reddit.com/message/compose?to=${encodeURIComponent(user.name)}`,
            matchedBy: 'search',
          });
        }
      }

      if (opts.profile.includeHotBrowse) {
        const hotPosts = await browseSubreddit(env, {
          subreddit,
          sort: 'hot',
          timeframe: 'day',
          limit: 20,
        });
        for (const post of hotPosts) {
          if (seen.has(post.id)) continue;
          seen.add(post.id);
          const user = await getUserAbout(env, post.author);
          if (!user) continue;
          raw.push({
            user: {
              name: user.name,
              karma: user.totalKarma,
              createdUtc: user.createdUtc,
            },
            post: {
              title: post.title,
              selftext: post.selftext,
              permalink: post.permalink,
              score: post.score,
              subreddit: post.subreddit,
              numComments: post.numComments,
              createdUtc: post.createdUtc,
            },
            profileUrl: profileUrl(user.name),
            composeUrlBase: `https://www.reddit.com/message/compose?to=${encodeURIComponent(user.name)}`,
            matchedBy: 'hot',
          });
        }
      }
    }

    return filterCandidates(raw, {
      contactedHandles: opts.contactedHandles,
      blockedHandles: opts.blockedHandles,
      maxPostAgeHours: opts.profile.maxPostAgeHours,
      now: opts.now,
    });
  } finally {
    await closeBrowser();
  }
}
