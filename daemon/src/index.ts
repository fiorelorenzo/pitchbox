/**
 * Standalone daemon entry point. Wraps the embeddable factory with process
 * signal handlers so SIGINT/SIGTERM drain in-flight iterations before exit.
 */
import { logger } from './logger.js';
import { startEmbeddedDaemon } from './embed.js';

const log = logger('main');

const daemon = startEmbeddedDaemon({ heartbeatModule: 'daemon' });

let shuttingDown = false;
const shutdown = async (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${sig}`);
  await daemon.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
