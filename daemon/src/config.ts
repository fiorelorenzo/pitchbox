import 'dotenv/config';

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  /** How often the main loop fires. */
  tickIntervalMs: readIntEnv('PITCHBOX_DAEMON_TICK_MS', 30_000),
  /** How often we emit a heartbeat. */
  heartbeatIntervalMs: readIntEnv('PITCHBOX_DAEMON_HEARTBEAT_MS', 30_000),
  /** How often the reply poller runs. */
  replyPollIntervalMs: readIntEnv('PITCHBOX_REPLY_POLL_MS', 5 * 60_000),
  /** Base URL of the web server. We POST scheduled run starts here. */
  webUrl: process.env.PITCHBOX_WEB_URL ?? 'http://127.0.0.1:5180',
  /** Skip reply-poller entirely when true. */
  repliesDisabled: process.env.PITCHBOX_REPLIES_DISABLED === '1',
};
