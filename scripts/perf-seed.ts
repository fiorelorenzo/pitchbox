// Performance seed for the index-audit benchmarks (issue #44).
//
// Inserts 100k draft_events and 100k run_events spread across whichever drafts
// and runs already exist in the target DB so the new (kind, created_at)
// indexes can be exercised with realistic volume.
//
// Usage:
//   tsx scripts/perf-seed.ts
//
// Point DATABASE_URL at a throwaway database — this script does not clean up.

import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

const TOTAL = 100_000;
const BATCH = 1_000;
const DRAFT_KINDS = ['created', 'reviewed', 'sent', 'rejected', 'replied'];
const RUN_KINDS = ['system', 'tool_use', 'tool_result', 'assistant', 'result'];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length] as T;
}

async function seedDraftEvents(db: ReturnType<typeof getDb>): Promise<void> {
  const drafts = await db.select({ id: schema.drafts.id }).from(schema.drafts).limit(500);
  if (drafts.length === 0) {
    console.warn('[perf-seed] no drafts found — skipping draft_events');
    return;
  }
  for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const rows = Array.from({ length: BATCH }, (_, i) => ({
      draftId: drafts[(offset + i) % drafts.length]!.id,
      event: pick(DRAFT_KINDS, offset + i),
      actor: 'perf-seed',
      details: {},
    }));
    await db.insert(schema.draftEvents).values(rows);
  }
  console.log(`[perf-seed] inserted ${TOTAL} draft_events`);
}

async function seedRunEvents(db: ReturnType<typeof getDb>): Promise<void> {
  const runs = await db.select({ id: schema.runs.id }).from(schema.runs).limit(500);
  if (runs.length === 0) {
    console.warn('[perf-seed] no runs found — skipping run_events');
    return;
  }
  for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const rows = Array.from({ length: BATCH }, (_, i) => ({
      runId: runs[(offset + i) % runs.length]!.id,
      seq: offset + i,
      kind: pick(RUN_KINDS, offset + i),
      payload: {},
      raw: '',
    }));
    await db.insert(schema.runEvents).values(rows);
  }
  console.log(`[perf-seed] inserted ${TOTAL} run_events`);
}

async function main(): Promise<void> {
  const db = getDb();
  await seedDraftEvents(db);
  await seedRunEvents(db);
  await db.execute(sql`ANALYZE draft_events`);
  await db.execute(sql`ANALYZE run_events`);
  console.log('[perf-seed] done');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
