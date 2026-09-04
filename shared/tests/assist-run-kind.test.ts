// #313: runs_kind_target_chk (shared/src/db/migrations/0013_assist_run_kind.sql)
// gains the 'assist' kind. Modelled on insights-run-kind.test.ts, the same
// pattern used to pin the constraint's acceptance of project_insights.
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

async function reset() {
  await getDb().execute(sql`TRUNCATE runs, campaigns, projects RESTART IDENTITY CASCADE`);
}

describe('runs_kind_target_chk: the assist run kind', () => {
  beforeEach(reset);

  it('accepts an assist run with a project_id', async () => {
    const db = getDb();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [proj] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'assist-chk', name: 'assist-chk' })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ kind: 'assist', projectId: proj.id, trigger: 'manual', status: 'success' })
      .returning();
    expect(run.kind).toBe('assist');
    expect(run.projectId).toBe(proj.id);
  });

  it('rejects an assist run without a project_id', async () => {
    const db = getDb();
    await expect(
      db.insert(schema.runs).values({ kind: 'assist', trigger: 'manual', status: 'success' }),
    ).rejects.toThrow();
  });

  // The constraint change is additive (an OR'd clause); this pins that the
  // pre-existing malformed pairings it already rejected still are.
  it('still rejects a malformed pairing on an unrelated kind (campaign with no campaign_id)', async () => {
    const db = getDb();
    await expect(
      db.insert(schema.runs).values({ kind: 'campaign', trigger: 'manual', status: 'running' }),
    ).rejects.toThrow();
  });
});
