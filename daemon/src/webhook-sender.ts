import { getDb, schema } from '@pitchbox/shared/db';
import { computeBackoff } from '@pitchbox/shared/scheduler/backoff';
import { sql } from 'drizzle-orm';
import { logger } from './logger.js';

const log = logger('webhook-sender');

/** Hard ceiling on a single delivery attempt's HTTP timeout. */
const HTTP_TIMEOUT_MS = 10_000;
/** How many rows we drain per tick. */
const BATCH_SIZE = 10;

export interface WebhookSendResult {
  picked: number;
  delivered: number;
  failed: number;
  dead: number;
}

type Row = {
  id: number;
  webhook_id: string;
  event_type: string;
  payload: { url?: string; body?: unknown } | null;
  attempts: number;
  max_attempts: number;
};

async function postOnce(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One worker tick. Picks up to BATCH_SIZE pending+due rows under
 * FOR UPDATE SKIP LOCKED so multiple daemon instances cooperate safely.
 */
export async function tick(): Promise<WebhookSendResult> {
  const db = getDb();
  const result: WebhookSendResult = { picked: 0, delivered: 0, failed: 0, dead: 0 };

  // Drizzle's transaction wrapper gives us a single client so SKIP LOCKED holds
  // for the rest of the transaction.
  await db.transaction(async (tx) => {
    const picked = await tx.execute(sql`
      SELECT id, webhook_id, event_type, payload, attempts, max_attempts
      FROM webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `);
    const rows = (picked.rows ?? []) as Row[];
    result.picked = rows.length;
    if (rows.length === 0) return;

    for (const row of rows) {
      const url = typeof row.payload?.url === 'string' ? row.payload.url : '';
      const body = row.payload?.body;
      if (!url) {
        // No URL → cannot deliver, mark dead so it doesn't loop.
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET status = 'dead', last_error = 'missing url', updated_at = now()
          WHERE id = ${row.id}
        `);
        result.dead += 1;
        continue;
      }

      const res = await postOnce(url, body);
      if (res.ok) {
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET status = 'delivered', last_error = NULL, attempts = ${row.attempts + 1}, updated_at = now()
          WHERE id = ${row.id}
        `);
        result.delivered += 1;
        continue;
      }

      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= row.max_attempts) {
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET status = 'dead', attempts = ${nextAttempts}, last_error = ${res.error ?? 'unknown'}, updated_at = now()
          WHERE id = ${row.id}
        `);
        result.dead += 1;
      } else {
        const delayMs = computeBackoff(nextAttempts);
        const nextAt = new Date(Date.now() + delayMs);
        await tx.execute(sql`
          UPDATE webhook_deliveries
          SET attempts = ${nextAttempts},
              last_error = ${res.error ?? 'unknown'},
              next_attempt_at = ${nextAt.toISOString()},
              updated_at = now()
          WHERE id = ${row.id}
        `);
        result.failed += 1;
      }
    }
  });

  if (result.picked > 0) {
    log.info(
      `picked=${result.picked} delivered=${result.delivered} failed=${result.failed} dead=${result.dead}`,
    );
  }
  return result;
}

// Re-export the table accessor so tests can reset cleanly without reaching
// into shared/.
export { schema };
