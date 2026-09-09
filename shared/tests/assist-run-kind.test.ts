// #521 reverses shared/src/db/migrations/0013_assist_run_kind.sql: an
// accepted suggestion writes into the assist plane's own ledger
// (assist_accepted_suggestions) now, never a `runs` row, so the 'assist'
// branch comes back out of runs_kind_target_chk
// (shared/src/db/migrations/0032_assist_migrate_legacy_runs.sql). This used
// to pin the constraint accepting 'assist' with a project_id; it now pins
// the opposite - not re-pinned to new internals, migrated to the contract
// that actually still matters here: an unrecognised kind is always
// rejected, whatever project/campaign pairing it carries.
import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

async function reset() {
  await getDb().execute(sql`TRUNCATE runs, campaigns, projects RESTART IDENTITY CASCADE`);
}

describe('runs_kind_target_chk: the retired assist run kind', () => {
  beforeEach(reset);

  it('rejects an assist run even with a project_id, now that the kind is retired', async () => {
    const db = getDb();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [proj] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'assist-chk', name: 'assist-chk' })
      .returning();
    await expect(
      db.insert(schema.runs).values({
        kind: 'assist',
        projectId: proj.id,
        trigger: 'manual',
        status: 'success',
      }),
    ).rejects.toThrow();
  });

  it('rejects an assist run without a project_id too', async () => {
    const db = getDb();
    await expect(
      db.insert(schema.runs).values({ kind: 'assist', trigger: 'manual', status: 'success' }),
    ).rejects.toThrow();
  });

  // The constraint change removed a clause; this pins that the pre-existing
  // pairings it already rejected still are.
  it('still rejects a malformed pairing on an unrelated kind (campaign with no campaign_id)', async () => {
    const db = getDb();
    await expect(
      db.insert(schema.runs).values({ kind: 'campaign', trigger: 'manual', status: 'running' }),
    ).rejects.toThrow();
  });
});
