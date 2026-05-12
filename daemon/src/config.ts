import 'dotenv/config';

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readFloatEnv(key: string, fallback: number, min = 0, max = 1): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const config = {
  /** How often the main loop fires. */
  tickIntervalMs: readIntEnv('PITCHBOX_DAEMON_TICK_MS', 30_000),
  /** How often we emit a heartbeat. */
  heartbeatIntervalMs: readIntEnv('PITCHBOX_DAEMON_HEARTBEAT_MS', 30_000),
  /** How often the reply poller runs. */
  replyPollIntervalMs: readIntEnv('PITCHBOX_REPLY_POLL_MS', 5 * 60_000),
  /** How often the webhook sender drains the delivery queue. */
  webhookSenderIntervalMs: readIntEnv('PITCHBOX_WEBHOOK_SENDER_MS', 30_000),
  /** How often the retention worker prunes ageing rows. */
  retentionIntervalMs: readIntEnv('PITCHBOX_RETENTION_MS', 60 * 60_000),
  /** How often the keyword watcher polls subreddits for matching posts. */
  keywordWatcherIntervalMs: readIntEnv('PITCHBOX_KEYWORD_WATCHER_MS', 5 * 60_000),
  /** Base URL of the web server. We POST scheduled run starts here. */
  webUrl: process.env.PITCHBOX_WEB_URL ?? 'http://127.0.0.1:5180',
  /** Skip reply-poller entirely when true. */
  repliesDisabled: process.env.PITCHBOX_REPLIES_DISABLED === '1',
  /**
   * Symmetric jitter applied to every loop's cadence, expressed as a fraction
   * of the base interval. 0 disables jitter; 0.1 means ±10%. Clamped to [0, 1].
   */
  jitterPct: readFloatEnv('DAEMON_JITTER_PCT', 0.1),
};
