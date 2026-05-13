import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

/**
 * Run `fn` while holding a Postgres transaction-scoped advisory lock keyed on
 * `campaign:<id>`. Returns the function's result on success, or `null` if the
 * lock could not be acquired (another writer already owns it).
 *
 * `pg_try_advisory_xact_lock` is non-blocking and auto-releases at COMMIT /
 * ROLLBACK, so callers don't need to clean up. We hash the `campaign:<id>`
 * string with `hashtextextended(..., 0)` to pick a stable bigint key without
 * requiring a separate sequence.
 *
 * The web `/api/run` endpoint and the daemon scheduler both wrap their
 * read-modify-write through this helper so concurrent dispatches collapse to
 * exactly one inserted `runs` row per `(campaign_id, scheduled_for)` tick.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withCampaignLock<TDb extends PgDatabase<any, any, any>, T>(
  db: TDb,
  campaignId: number,
  fn: (tx: TDb) => Promise<T>,
): Promise<T | null> {
  // Drizzle's transaction callback receives a tx-bound client of the same
  // type; cast through the generic so callers don't lose type info.
  return await db.transaction(async (tx) => {
    const key = `campaign:${campaignId}`;
    const got = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`,
    );
    // node-postgres returns `{ rows: [...] }`; drizzle proxies that.
    const rows = (got as { rows?: Array<{ locked: boolean }> }).rows ?? [];
    const locked = rows[0]?.locked === true;
    if (!locked) return null as T | null;
    return await fn(tx as unknown as TDb);
  });
}
