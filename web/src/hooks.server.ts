import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';

/**
 * One-shot cleanup on server boot.
 *
 * The `runs` table stores an in-flight run as `status='running'`, and the
 * runner keeps the cancel handle in an in-memory map. If the dev server
 * restarts (HMR, crash, manual stop) that map is lost but the DB row is
 * left stuck as running forever. On boot we mark any such orphans as
 * failed so the UI doesn't show phantom "Running" states.
 */
async function reapOrphanedRuns() {
  try {
    const db = getDb();
    const now = new Date();
    const result = await db
      .update(schema.runs)
      .set({
        status: 'failed',
        finishedAt: now,
        error: 'orphaned by server restart',
      })
      .where(eq(schema.runs.status, 'running'))
      .returning({ id: schema.runs.id });
    if (result.length > 0) {
      console.log(
        `[hooks] reaped ${result.length} orphaned run(s):`,
        result.map((r) => r.id),
      );
    }
  } catch (err) {
    console.error('[hooks] failed to reap orphaned runs:', err);
  }
}

// Run once at module load (first request to the server).
await reapOrphanedRuns();

export const handle = async ({ event, resolve }) => resolve(event);
