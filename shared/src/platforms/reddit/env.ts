export type RedditEnv = {
  minIntervalMs: number;
  maxIntervalMs: number;
  concurrency: number;
  headless: boolean;
};

export type ScoutEnv = RedditEnv;

export function loadEnv(): RedditEnv {
  const env = process.env;
  return {
    minIntervalMs: Number(env.REDDIT_SCOUT_MIN_INTERVAL_MS ?? 800),
    maxIntervalMs: Number(env.REDDIT_SCOUT_MAX_INTERVAL_MS ?? 2000),
    concurrency: Math.max(1, Number(env.REDDIT_SCOUT_CONCURRENCY ?? 3)),
    headless: (env.REDDIT_SCOUT_HEADLESS ?? 'true') !== 'false',
  };
}
