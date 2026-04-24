import {
  browserBrowseSubreddit,
  browserGetPostAndComments,
  browserGetPostComments,
  browserGetSubredditAbout,
  browserGetSubredditRules,
  browserGetUserAbout,
  browserGetUserPosts,
  browserSearchPosts,
  closeBrowser,
  type BrowseOpts,
  type SearchOpts
} from './client.js';
import { cacheGet, cacheSet } from './cache.js';
import type { RedditEnv } from './env.js';
import type {
  RedditComment,
  RedditPost,
  RedditSubredditAbout,
  RedditSubredditRule,
  RedditUserAbout
} from './types.js';

const BASE = 'https://www.reddit.com';

export async function searchPosts(env: RedditEnv, opts: SearchOpts): Promise<RedditPost[]> {
  const key = `search:${opts.query}:${opts.sort}:${opts.timeframe}:${opts.limit}`;
  const cached = await cacheGet<RedditPost[]>(key);
  if (cached !== null) return cached;
  const posts = await browserSearchPosts(env, opts);
  await cacheSet(key, posts);
  return posts;
}

export async function browseSubreddit(env: RedditEnv, opts: BrowseOpts): Promise<RedditPost[]> {
  const key = `browse:${opts.subreddit.toLowerCase()}:${opts.sort}:${opts.timeframe}:${opts.limit}`;
  const cached = await cacheGet<RedditPost[]>(key);
  if (cached !== null) return cached;
  const posts = await browserBrowseSubreddit(env, opts);
  await cacheSet(key, posts);
  return posts;
}

export async function getUserAbout(
  env: RedditEnv,
  username: string
): Promise<RedditUserAbout | null> {
  const key = `user:${username.toLowerCase()}`;
  const cached = await cacheGet<RedditUserAbout | null>(key);
  if (cached !== null) return cached;
  const user = await browserGetUserAbout(env, username);
  await cacheSet(key, user);
  return user;
}

export async function getSubredditRules(
  env: RedditEnv,
  subreddit: string
): Promise<RedditSubredditRule[]> {
  const key = `rules:${subreddit.toLowerCase()}`;
  const cached = await cacheGet<RedditSubredditRule[]>(key);
  if (cached !== null) return cached;
  const rules = await browserGetSubredditRules(env, subreddit);
  await cacheSet(key, rules);
  return rules;
}

export async function getSubredditAbout(
  env: RedditEnv,
  subreddit: string
): Promise<RedditSubredditAbout | null> {
  const key = `about:${subreddit.toLowerCase()}`;
  const cached = await cacheGet<RedditSubredditAbout | null>(key);
  if (cached !== null) return cached;
  const about = await browserGetSubredditAbout(env, subreddit);
  await cacheSet(key, about);
  return about;
}

export async function getPostComments(
  env: RedditEnv,
  permalink: string,
  limit: number
): Promise<RedditComment[]> {
  const key = `comments:${permalink}:${limit}`;
  const cached = await cacheGet<RedditComment[]>(key);
  if (cached !== null) return cached;
  const comments = await browserGetPostComments(env, permalink, limit);
  await cacheSet(key, comments);
  return comments;
}

export async function getPostAndComments(
  env: RedditEnv,
  permalink: string,
  commentLimit: number
): Promise<{ post: RedditPost | null; comments: RedditComment[] }> {
  const key = `post-and-comments:${permalink}:${commentLimit}`;
  const cached = await cacheGet<{ post: RedditPost | null; comments: RedditComment[] }>(key);
  if (cached !== null) return cached;
  const result = await browserGetPostAndComments(env, permalink, commentLimit);
  await cacheSet(key, result);
  return result;
}

export async function getUserPosts(
  env: RedditEnv,
  username: string,
  limit: number
): Promise<RedditPost[]> {
  const key = `user-posts:${username.toLowerCase()}:${limit}`;
  const cached = await cacheGet<RedditPost[]>(key);
  if (cached !== null) return cached;
  const posts = await browserGetUserPosts(env, username, limit);
  await cacheSet(key, posts);
  return posts;
}

export function postUrl(post: RedditPost): string {
  return `${BASE}${post.permalink.startsWith('/') ? '' : '/'}${post.permalink}`;
}

export function profileUrl(username: string): string {
  return `${BASE}/user/${encodeURIComponent(username)}`;
}

export { closeBrowser };
