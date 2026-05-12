import { getDb, schema } from '@pitchbox/shared/db';
import { and, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import cronParser from 'cron-parser';
import { computeBackoff, FAILURE_PAUSE_THRESHOLD } from '@pitchbox/shared/scheduler/backoff';
import { notify } from '@pitchbox/shared/notifications';
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
 *  - fetch active campaigns with cron_expression set that aren't paused by
 *    the circuit breaker;
 *  - for each: if next_run_at is null, seed it from the cron expression;
 *  - for each due campaign: dispatch via the web HTTP endpoint; on failure,
 *    increment the failure counter, set next_attempt_after via exponential
 *    backoff, and pause the campaign once the threshold is reached.
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
        eq(schema.campaigns.pausedDueToFailures, false),
        isNotNull(schema.campaigns.cronExpression),
        // Due if either the cron tick or the backoff timer has elapsed.
        // Backoff (next_attempt_after) takes precedence when present.
        or(
          and(
            isNotNull(schema.campaigns.nextAttemptAfter),
            lte(schema.campaigns.nextAttemptAfter, now),
          ),
          and(
            isNull(schema.campaigns.nextAttemptAfter),
            or(isNull(schema.campaigns.nextRunAt), lte(schema.campaigns.nextRunAt, now)),
          ),
        ),
      ),
    );

  if (campaigns.length === 0) return;

  for (const c of campaigns) {
    if (!c.cronExpression) continue;

    // If next_run_at is still null and we're not already in backoff, seed it
    // from the cron expression without dispatching this tick.
    if (c.nextRunAt == null && c.nextAttemptAfter == null) {
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
      // Reset backoff state on success and resume the cron schedule.
      await db
        .update(schema.campaigns)
        .set({
          lastRunAt: now,
          nextRunAt: nextRun ?? null,
          nextAttemptAfter: null,
          consecutiveFailures: 0,
          failureAttempts: 0,
        })
        .where(eq(schema.campaigns.id, c.id));
      log.info(
        `triggered campaign #${c.id} (${c.name}) → run #${res.runId ?? '?'}, next=${nextRun?.toISOString() ?? 'n/a'}`,
      );
    } else {
      const newAttempts = c.failureAttempts + 1;
      const shouldPause = newAttempts >= FAILURE_PAUSE_THRESHOLD;
      const delayMs = computeBackoff(newAttempts);
      const nextAttempt = new Date(now.getTime() + delayMs);
      await db
        .update(schema.campaigns)
        .set({
          // Keep the cron tick advancing so resuming after a pause picks up
          // an up-to-date next_run_at (we still honour next_attempt_after
          // first while in backoff).
          nextRunAt: nextRun ?? null,
          nextAttemptAfter: shouldPause ? null : nextAttempt,
          failureAttempts: newAttempts,
          consecutiveFailures: c.consecutiveFailures + 1,
          pausedDueToFailures: shouldPause,
        })
        .where(eq(schema.campaigns.id, c.id));
      if (shouldPause) {
        log.warn(
          `paused campaign #${c.id} after ${newAttempts} consecutive failures: ${res.error}`,
        );
        await notify(db, {
          kind: 'campaign.paused',
          title: `Campaign #${c.id} paused`,
          body: `Pitchbox stopped dispatching after ${newAttempts} consecutive failures. Last error: ${res.error}`,
          payload: { campaignId: c.id, attempts: newAttempts, lastError: res.error },
          severity: 'error',
        });
      } else {
        log.warn(
          `failed to trigger campaign #${c.id}: ${res.error}. retry at ${nextAttempt.toISOString()} (attempt ${newAttempts})`,
        );
      }
    }
  }
}
