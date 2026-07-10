import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { getDb, schema } from '../../src/db/client.js';
import { withCampaignLock } from '../../src/scheduler/dispatch-lock.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function seedCampaign(slug: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [c] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform!.id,
      name: slug,
      skillSlug: 'reddit-scout',
      cronExpression: '* * * * *',
    })
    .returning();
  return c;
}

describe('withCampaignLock', () => {
  beforeEach(reset);

  it('runs the callback when the lock is free and returns its result', async () => {
    const c = await seedCampaign('lock-free');
    const result = await withCampaignLock(getDb(), c.id, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('returns null to a second caller while the first is still holding the lock', async () => {
    const c = await seedCampaign('lock-busy');
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => {
      release = res;
    });

    const first = withCampaignLock(getDb(), c.id, async () => {
      await gate;
      return 'first';
    });
    // Allow the first transaction to acquire the lock before the second tries.
    await new Promise((r) => setTimeout(r, 20));
    const second = await withCampaignLock(getDb(), c.id, async () => 'second');
    expect(second).toBeNull();

    release!();
    expect(await first).toBe('first');
  });

  it('serialises concurrent dispatch inserts so exactly one runs row is created', async () => {
    const c = await seedCampaign('lock-race');
    const scheduledFor = new Date('2026-05-12T00:00:00Z');

    async function attempt(): Promise<'inserted' | 'skipped'> {
      const got = await withCampaignLock(getDb(), c.id, async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.runs)
          .where(and(eq(schema.runs.campaignId, c.id), eq(schema.runs.scheduledFor, scheduledFor)))
          .limit(1);
        if (existing) return 'skipped' as const;
        await tx.insert(schema.runs).values({
          campaignId: c.id,
          trigger: 'scheduled',
          status: 'running',
          scheduledFor,
        });
        return 'inserted' as const;
      });
      // Lock unavailable counts as "skipped" too - both losers are equivalent
      // for the caller.
      return got ?? 'skipped';
    }

    const outcomes = await Promise.all([attempt(), attempt(), attempt()]);
    const inserts = outcomes.filter((o) => o === 'inserted').length;
    expect(inserts).toBe(1);

    const rows = await getDb()
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.campaignId, c.id), eq(schema.runs.scheduledFor, scheduledFor)));
    expect(rows.length).toBe(1);
  });

  it('the partial unique index rejects a second row with the same (campaign_id, scheduled_for)', async () => {
    const c = await seedCampaign('lock-unique');
    const scheduledFor = new Date('2026-05-12T01:00:00Z');
    await getDb().insert(schema.runs).values({
      campaignId: c.id,
      trigger: 'scheduled',
      status: 'success',
      scheduledFor,
    });
    await expect(
      getDb().insert(schema.runs).values({
        campaignId: c.id,
        trigger: 'scheduled',
        status: 'running',
        scheduledFor,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
