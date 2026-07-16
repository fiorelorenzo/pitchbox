import {
  acquireBrowser,
  browseSubreddit,
  closeBrowser,
  getUserAbout,
  searchPosts,
  profileUrl,
} from './reddit.js';
import { loadEnv } from './env.js';
import { filterCandidates } from './filter.js';
import type { ScoutCandidate, ScoutProfile } from './types.js';

export interface RunScoutOptions {
  profile: ScoutProfile;
  contactedHandles: Set<string>;
  blockedHandles: Set<string>;
  verbose?: boolean;
}

export async function runScout(opts: RunScoutOptions): Promise<ScoutCandidate[]> {
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
          sort: 'relevance',
          timeframe: 'month',
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
    });
  } finally {
    await closeBrowser();
  }
}
