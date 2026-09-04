export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
export type SortMode = 'relevance' | 'new' | 'top' | 'hot' | 'comments';

export type RedditPost = {
  id: string;
  subreddit: string;
  title: string;
  selftext: string;
  permalink: string;
  url: string;
  score: number;
  numComments: number;
  createdUtc: number;
  author: string;
  authorFullname: string | null;
  over18: boolean;
  locked: boolean;
  stickied: boolean;
  linkFlairText?: string | null;
};

export type RedditUserAbout = {
  name: string;
  id: string;
  totalKarma: number;
  linkKarma: number;
  commentKarma: number;
  createdUtc: number;
  isSuspended: boolean;
  isEmployee: boolean;
  acceptsFollowers: boolean;
};

export type RedditComment = {
  id: string;
  author: string;
  score: number;
  body: string;
  createdUtc: number;
};

export type RedditSubredditRule = {
  shortName: string;
  description: string;
  kind: string;
  priority: number;
};

export type RedditSubredditAbout = {
  name: string;
  title: string;
  subscribers: number;
  publicDescription: string;
  submissionType: string;
  over18: boolean;
};

export interface ScoutProfile {
  targetSubreddits: string[];
  topicKeywords?: string[];
  perSubredditLimit?: number;
  includeHotBrowse?: boolean;
  minKarma?: number;
  maxAccountAgeDays?: number;
  minPostScore?: number;
  /**
   * Posts older than this are dropped as stale at collection time, before
   * any drafting happens (#338). Unset/null falls back to the scout's
   * default (72h) - an existing campaign with no such key in its config
   * still gets the cap, not "no cap". An explicit 0 caps immediately
   * (everything is older than zero hours); there is no sentinel for
   * disabling the filter.
   */
  maxPostAgeHours?: number | null;
}

export interface ScoutCandidate {
  user: { name: string; karma: number; createdUtc: number };
  post: {
    title: string;
    selftext: string;
    permalink: string;
    score: number;
    subreddit: string;
    numComments: number;
    createdUtc: number;
  };
  profileUrl: string;
  composeUrlBase: string;
  matchedBy: 'search' | 'hot';
}
