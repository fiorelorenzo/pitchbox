import { config } from './config.js';
import { logger } from './logger.js';
import { beat } from './heartbeat.js';
import { tick as schedulerTick } from './scheduler.js';
import { tick as replyPollerTick } from './reply-poller.js';

const log = logger('main');

let running = true;

type Loop = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

function every(ms: number, fn: () => Promise<void>): { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const kick = async () => {
    if (cancelled) return;
    try {
      await fn();
    } catch (err) {
      log.error('loop iteration crashed', err);
    } finally {
      if (!cancelled) timer = setTimeout(kick, ms);
    }
  };

  void kick();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function main() {
  log.info(`pitchbox daemon starting (web=${config.webUrl})`);

  const loops: Loop[] = [
    {
      name: 'heartbeat',
      intervalMs: config.heartbeatIntervalMs,
      run: () => beat('daemon'),
    },
    {
      name: 'scheduler',
      intervalMs: config.tickIntervalMs,
      run: schedulerTick,
    },
  ];

  if (!config.repliesDisabled) {
    loops.push({
      name: 'reply-poller',
      intervalMs: config.replyPollIntervalMs,
      run: async () => {
        const res = await replyPollerTick();
        if (res.checked > 0) {
          logger('reply-poller').info(
            `checked ${res.checked} contacts → ${res.newReplies} new replies, ${res.skipped} skipped`,
          );
        }
      },
    });
  }

  const cancels = loops.map((l) => {
    log.info(`starting loop "${l.name}" every ${l.intervalMs}ms`);
    return every(l.intervalMs, l.run);
  });

  const shutdown = (sig: string) => {
    if (!running) return;
    running = false;
    log.info(`received ${sig}, shutting down`);
    for (const c of cancels) c.cancel();
    setTimeout(() => process.exit(0), 250);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
