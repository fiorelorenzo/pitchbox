/**
 * Embeddable daemon: the same loops the standalone `pitchbox daemon` runs,
 * exported as a `start()` factory the web server can invoke at boot when
 * PITCHBOX_EMBED_DAEMON=1.
 *
 * The advisory lock around dispatch (#32) and `SELECT … FOR UPDATE SKIP LOCKED`
 * on webhook deliveries (#36) already make these loops safe to run from
 * multiple processes; embedding here removes the friction of supervising a
 * second Node process on single-host installs.
 */
import { applyJitter } from '@pitchbox/shared/scheduler/jitter';
import { config } from './config.js';
import { logger } from './logger.js';
import { beat } from './heartbeat.js';
import { tick as schedulerTick } from './scheduler.js';
import { tick as replyPollerTick } from './reply-poller.js';
import { tick as webhookSenderTick } from './webhook-sender.js';
import { tick as retentionTick } from './retention.js';
import { tick as keywordWatcherTick } from './keyword-watcher.js';

const log = logger('embed');

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

export type StartOptions = {
  /** Identifier for the heartbeat row. Use 'daemon' for standalone, 'web' for embedded. */
  heartbeatModule?: string;
};

export type EmbeddedDaemon = {
  /** Stop all loops; awaits in-flight iterations up to 10s before resolving. */
  stop(): Promise<void>;
};

export function startEmbeddedDaemon(opts: StartOptions = {}): EmbeddedDaemon {
  const heartbeatModule = opts.heartbeatModule ?? 'daemon';
  log.info(`starting embedded daemon (web=${config.webUrl}, heartbeat=${heartbeatModule})`);

  const loops: Loop[] = [
    {
      name: 'heartbeat',
      intervalMs: config.heartbeatIntervalMs,
      run: () => beat(heartbeatModule),
    },
    {
      name: 'scheduler',
      intervalMs: config.tickIntervalMs,
      run: schedulerTick,
    },
    {
      name: 'retention',
      intervalMs: config.retentionIntervalMs,
      run: async () => {
        const res = await retentionTick();
        if (res.runEventsDeleted + res.draftEventsDeleted + res.draftsDeleted > 0) {
          logger('retention').info(
            `pruned run_events=${res.runEventsDeleted} draft_events=${res.draftEventsDeleted} drafts=${res.draftsDeleted}`,
          );
        }
      },
    },
    {
      name: 'keyword-watcher',
      intervalMs: config.keywordWatcherIntervalMs,
      run: async () => {
        const res = await keywordWatcherTick();
        if (res.checked > 0) {
          logger('keyword-watcher').info(
            `checked ${res.checked} watches → ${res.dispatched} dispatched`,
          );
        }
      },
    },
    {
      name: 'webhook-sender',
      intervalMs: config.webhookSenderIntervalMs,
      run: async () => {
        await webhookSenderTick();
      },
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

  const handles = loops.map((l) => {
    log.info(`starting loop "${l.name}" every ${l.intervalMs}ms`);
    return every(l.intervalMs, l.run);
  });

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      log.info('draining loops');
      for (const h of handles) h.cancel();
      const drain = Promise.all(handles.map((h) => h.settle()));
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      await Promise.race([drain, timeout]);
      log.info('stopped');
    },
  };
}
