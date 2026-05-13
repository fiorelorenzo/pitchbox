import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daemon config is built once at module load time. To test env precedence
 * we mutate `process.env`, reset the module registry, then re-import.
 */
async function loadConfig() {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.config;
}

const KEYS = [
  'PITCHBOX_DAEMON_TICK_MS',
  'PITCHBOX_DAEMON_HEARTBEAT_MS',
  'PITCHBOX_REPLY_POLL_MS',
  'PITCHBOX_WEB_URL',
  'PITCHBOX_REPLIES_DISABLED',
] as const;

let originals: Record<string, string | undefined>;

describe('daemon config', () => {
  beforeEach(() => {
    originals = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
      string,
      string | undefined
    >;
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
    vi.resetModules();
  });

  it('falls back to defaults when no env vars are set', async () => {
    const cfg = await loadConfig();
    expect(cfg.tickIntervalMs).toBe(30_000);
    expect(cfg.heartbeatIntervalMs).toBe(30_000);
    expect(cfg.replyPollIntervalMs).toBe(5 * 60_000);
    expect(cfg.webUrl).toBe('http://127.0.0.1:5180');
    expect(cfg.repliesDisabled).toBe(false);
  });

  it('env vars take precedence over defaults', async () => {
    process.env.PITCHBOX_DAEMON_TICK_MS = '1234';
    process.env.PITCHBOX_DAEMON_HEARTBEAT_MS = '5678';
    process.env.PITCHBOX_REPLY_POLL_MS = '9012';
    process.env.PITCHBOX_WEB_URL = 'http://example.test:9999';
    process.env.PITCHBOX_REPLIES_DISABLED = '1';

    const cfg = await loadConfig();
    expect(cfg.tickIntervalMs).toBe(1234);
    expect(cfg.heartbeatIntervalMs).toBe(5678);
    expect(cfg.replyPollIntervalMs).toBe(9012);
    expect(cfg.webUrl).toBe('http://example.test:9999');
    expect(cfg.repliesDisabled).toBe(true);
  });

  it('ignores non-positive or non-numeric ints and uses the default', async () => {
    process.env.PITCHBOX_DAEMON_TICK_MS = 'not-a-number';
    process.env.PITCHBOX_DAEMON_HEARTBEAT_MS = '0';
    process.env.PITCHBOX_REPLY_POLL_MS = '-50';

    const cfg = await loadConfig();
    expect(cfg.tickIntervalMs).toBe(30_000);
    expect(cfg.heartbeatIntervalMs).toBe(30_000);
    expect(cfg.replyPollIntervalMs).toBe(5 * 60_000);
  });

  it('repliesDisabled is only true for exact "1"', async () => {
    process.env.PITCHBOX_REPLIES_DISABLED = 'true';
    let cfg = await loadConfig();
    expect(cfg.repliesDisabled).toBe(false);

    process.env.PITCHBOX_REPLIES_DISABLED = '1';
    cfg = await loadConfig();
    expect(cfg.repliesDisabled).toBe(true);
  });
});
