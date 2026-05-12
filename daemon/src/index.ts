import { applyJitter } from '@pitchbox/shared/scheduler/jitter';
import { config } from './config.js';
import { logger } from './logger.js';
import { beat } from './heartbeat.js';
import { tick as schedulerTick } from './scheduler.js';
import { tick as replyPollerTick } from './reply-poller.js';
import { tick as webhookSenderTick } from './webhook-sender.js';

const log = logger('main');

let running = true;

type Loop = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

type LoopHandle = { cancel: () => void; settle: () => Promise<void> };

function every(ms: number, fn: () => Promise<void>): LoopHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let inflight: Promise<void> | null = null;

  const kick = async () => {
    if (cancelled) return;
    const run = (async () => {
      try {
        await fn();
      } catch (err) {
        log.error('loop iteration crashed', err);
      }
    })();
    inflight = run;
    try {
      await run;
    } finally {
      inflight = null;
      // Apply symmetric jitter so concurrent loops (and multi-instance daemons)
      // don't lock-step on the same tick.
      if (!cancelled) timer = setTimeout(kick, applyJitter(ms, config.jitterPct));
    }
  };

  void kick();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
    async settle() {
      if (inflight) await inflight;
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

  loops.push({
    name: 'webhook-sender',
    intervalMs: config.webhookSenderIntervalMs,
    run: async () => {
      await webhookSenderTick();
    },
  });

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

  const shutdown = async (sig: string) => {
    if (!running) return;
    running = false;
    log.info(`received ${sig}, draining loops`);
    for (const c of cancels) c.cancel();
    // Wait up to 10s for in-flight iterations (HTTP POST to /api/run, reply
    // polling) to finish — beats killing them mid-request.
    const drain = Promise.all(cancels.map((c) => c.settle()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    await Promise.race([drain, timeout]);
    log.info('exit');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
