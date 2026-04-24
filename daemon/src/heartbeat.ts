import { getDb, schema } from '@pitchbox/shared/db';
import { sql } from 'drizzle-orm';
import { logger } from './logger.js';

const log = logger('heartbeat');

/**
 * Upsert a heartbeat row for this module. The main page reads this to show liveness.
 * Module is the primary key; we use it to distinguish different daemon components
 * (scheduler, reply-poller) if we ever split them.
 */
export async function beat(moduleName: string): Promise<void> {
  const db = getDb();
  try {
    await db
      .insert(schema.daemonHeartbeats)
      .values({ module: moduleName, tickAt: new Date() })
      .onConflictDoUpdate({
        target: schema.daemonHeartbeats.module,
        set: { tickAt: sql`excluded.tick_at` },
      });
  } catch (err) {
    log.error(`failed to persist heartbeat for ${moduleName}`, err);
  }
}
