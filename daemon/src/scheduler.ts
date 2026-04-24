import { getDb, schema } from '@pitchbox/shared/db';
import { and, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import cronParser from 'cron-parser';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger('scheduler');

/**
 * Ask the web server to start a campaign. We go through the HTTP endpoint rather
 * than importing runCampaign directly: the web process owns the SSE event bus
 * and the in-memory cancellation map, and it already has the partial-unique-index
 * guard for double-starts.
 */
async function triggerRun(
  campaignId: number,
): Promise<{ ok: boolean; runId?: number; error?: string }> {
  const url = `${config.webUrl}/api/run`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId, trigger: 'scheduled' }),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${await res.text().catch(() => '')}` };
    }
    const body = (await res.json()) as { runId?: number };
    return { ok: true, runId: body.runId };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function computeNextRun(cronExpression: string, from: Date): Date | null {
  try {
    const it = cronParser.parseExpression(cronExpression, { currentDate: from, tz: 'UTC' });
    return it.next().toDate();
  } catch (err) {
    log.warn(`invalid cron expression "${cronExpression}"`, err);
    return null;
  }
}

/**
 * One scheduler tick:
 *  - fetch active campaigns with cron_expression set
 *  - for each: if next_run_at is null, seed it from the cron expression
 *  - for each: if next_run_at <= now, trigger a run and advance next_run_at
 */
export async function tick(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const campaigns = await db
    .select()
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.status, 'active'),
        isNotNull(schema.campaigns.cronExpression),
        or(isNull(schema.campaigns.nextRunAt), lte(schema.campaigns.nextRunAt, now)),
      ),
    );

  if (campaigns.length === 0) return;

  for (const c of campaigns) {
    if (!c.cronExpression) continue;

    // If next_run_at is still null, seed it without triggering; we only trigger
    // on subsequent ticks where the threshold has been crossed.
    if (c.nextRunAt == null) {
      const seeded = computeNextRun(c.cronExpression, now);
      if (seeded) {
        await db
          .update(schema.campaigns)
          .set({ nextRunAt: seeded })
          .where(eq(schema.campaigns.id, c.id));
        log.info(`seeded campaign #${c.id} (${c.name}) next run at ${seeded.toISOString()}`);
      }
      continue;
    }

    const res = await triggerRun(c.id);
    const nextRun = computeNextRun(c.cronExpression, now);

    if (res.ok) {
      await db
        .update(schema.campaigns)
        .set({ lastRunAt: now, nextRunAt: nextRun ?? null, consecutiveFailures: 0 })
        .where(eq(schema.campaigns.id, c.id));
      log.info(
        `triggered campaign #${c.id} (${c.name}) → run #${res.runId ?? '?'}, next=${nextRun?.toISOString() ?? 'n/a'}`,
      );
    } else {
      // Advance next_run_at anyway so we don't hammer a broken endpoint, but bump the failure counter.
      await db
        .update(schema.campaigns)
        .set({ nextRunAt: nextRun ?? null, consecutiveFailures: c.consecutiveFailures + 1 })
        .where(eq(schema.campaigns.id, c.id));
      log.warn(
        `failed to trigger campaign #${c.id}: ${res.error}. retry at ${nextRun?.toISOString() ?? 'n/a'}`,
      );
    }
  }
}
