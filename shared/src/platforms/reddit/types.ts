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
