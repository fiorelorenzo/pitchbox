import { getDb, schema } from '@pitchbox/shared/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger('insights');

const DAY_MS = 24 * 60 * 60_000;

async function triggerRun(projectId: number): Promise<boolean> {
  const url = `${config.webUrl}/api/projects/${projectId}/insights`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return res.ok || res.status === 409;
  } catch (err) {
    log.warn(`trigger failed for project ${projectId}: ${String(err)}`);
    return false;
  }
}

/**
 * One insights tick: find projects with draft/message activity in the last 24h,
 * skip those with a project_insights row newer than 24h or fewer than 5 drafts,
 * and dispatch a project_insights run for the rest. Impls are injectable for tests.
 */
export async function tick(
  triggerRunImpl: (projectId: number) => Promise<boolean> = triggerRun,
  nowImpl: () => Date = () => new Date(),
): Promise<{ checked: number; dispatched: number; skipped: number }> {
  const db = getDb();
  const cutoff = new Date(nowImpl().getTime() - DAY_MS);

  const byDraft = await db
    .selectDistinct({ projectId: schema.drafts.projectId })
    .from(schema.drafts)
    .where(gt(schema.drafts.createdAt, cutoff));
  const byMessage = await db
    .selectDistinct({ projectId: schema.drafts.projectId })
    .from(schema.messages)
    .innerJoin(schema.drafts, eq(schema.drafts.id, schema.messages.draftId))
    .where(and(eq(schema.messages.isFromUs, false), gt(schema.messages.capturedAt, cutoff)));

  const candidateIds = Array.from(new Set([...byDraft, ...byMessage].map((r) => r.projectId)));

  let dispatched = 0;
  let skipped = 0;
  for (const projectId of candidateIds) {
    const [fresh] = await db
      .select({ id: schema.projectInsights.id })
      .from(schema.projectInsights)
      .where(
        and(
          eq(schema.projectInsights.projectId, projectId),
          gt(schema.projectInsights.generatedAt, cutoff),
        ),
      )
      .limit(1);
    if (fresh) {
      skipped++;
      continue;
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.drafts)
      .where(eq(schema.drafts.projectId, projectId));
    if (count < 5) {
      skipped++;
      continue;
    }

    const ok = await triggerRunImpl(projectId);
    if (ok) dispatched++;
    else skipped++;
  }

  return { checked: candidateIds.length, dispatched, skipped };
}
