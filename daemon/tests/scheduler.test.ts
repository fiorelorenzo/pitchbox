import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { tick as schedulerTick } from '../src/scheduler.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, notifications RESTART IDENTITY CASCADE`,
  );
}

async function setupCampaign(opts: {
  cron: string | null;
  status?: string;
  nextRunAt?: Date | null;
  consecutiveFailures?: number;
}) {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'sched-test', name: 'sched-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform!.id,
      name: 'sched-c',
      skillSlug: 'reddit-scout',
      cronExpression: opts.cron,
      status: opts.status ?? 'active',
      nextRunAt: opts.nextRunAt ?? null,
      consecutiveFailures: opts.consecutiveFailures ?? 0,
    })
    .returning();
  return { proj, platform: platform!, campaign };
}

describe('scheduler tick', () => {
  beforeEach(async () => {
    await reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds next_run_at without firing when it is null', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ runId: 1 }), { status: 200 }));

    // Every minute → next slot is in the future relative to "now".
    const { campaign } = await setupCampaign({ cron: '* * * * *', nextRunAt: null });

    await schedulerTick();

    expect(fetchSpy).not.toHaveBeenCalled();
    const [row] = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(row.nextRunAt).not.toBeNull();
    // Seeded value must be in the future (cron-parser .next() always advances).
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('fires a POST and advances next_run_at when due', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ runId: 42 }), { status: 200 }));

    // next_run_at in the past → should fire now.
    const past = new Date(Date.now() - 60_000);
    const { campaign } = await setupCampaign({ cron: '* * * * *', nextRunAt: past });

    await schedulerTick();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/run$/);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ campaignId: campaign.id, trigger: 'scheduled' });

    const [row] = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(row.lastRunAt).not.toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(past.getTime());
  });

  it('does not fire when next_run_at is in the future', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const future = new Date(Date.now() + 5 * 60_000);
    await setupCampaign({ cron: '* * * * *', nextRunAt: future });

    await schedulerTick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bumps consecutive_failures when the POST fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('boom', { status: 500 }));

    const past = new Date(Date.now() - 60_000);
    const { campaign } = await setupCampaign({
      cron: '* * * * *',
      nextRunAt: past,
      consecutiveFailures: 2,
    });

    await schedulerTick();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [row] = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(row.consecutiveFailures).toBe(3);
    // last_run_at not advanced on failure
    expect(row.lastRunAt).toBeNull();
  });

  it('skips paused campaigns even when due', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const past = new Date(Date.now() - 60_000);
    await setupCampaign({ cron: '* * * * *', nextRunAt: past, status: 'paused' });

    await schedulerTick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('schedules a backoff retry on dispatch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    const past = new Date(Date.now() - 60_000);
    const { campaign } = await setupCampaign({ cron: '* * * * *', nextRunAt: past });

    const before = Date.now();
    await schedulerTick();
    const [row] = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));

    expect(row.failureAttempts).toBe(1);
    expect(row.pausedDueToFailures).toBe(false);
    expect(row.nextAttemptAfter).not.toBeNull();
    // First-failure backoff is 60s — give a generous tolerance for clock skew.
    const delta = row.nextAttemptAfter!.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(50_000);
    expect(delta).toBeLessThanOrEqual(120_000);
  });

  it('honours next_attempt_after over the cron tick while in backoff', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    // next_run_at is in the past (cron-tick says due) but next_attempt_after
    // is in the future → scheduler must NOT fire yet.
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 5 * 60_000);
    const db = getDb();
    const [proj] = await db
      .insert(schema.projects)
      .values({ slug: 'sched-backoff', name: 'sched-backoff' })
      .returning();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    await db.insert(schema.campaigns).values({
      projectId: proj.id,
      platformId: platform!.id,
      name: 'backoff-c',
      skillSlug: 'reddit-scout',
      cronExpression: '* * * * *',
      nextRunAt: past,
      nextAttemptAfter: future,
      failureAttempts: 3,
    });

    await schedulerTick();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears backoff state and resumes the cron schedule on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ runId: 7 }), { status: 200 }),
    );

    const past = new Date(Date.now() - 60_000);
    const db = getDb();
    const [proj] = await db
      .insert(schema.projects)
      .values({ slug: 'sched-recover', name: 'sched-recover' })
      .returning();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: proj.id,
        platformId: platform!.id,
        name: 'recover-c',
        skillSlug: 'reddit-scout',
        cronExpression: '* * * * *',
        nextAttemptAfter: past,
        failureAttempts: 4,
        consecutiveFailures: 4,
      })
      .returning();

    await schedulerTick();

    const [row] = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(row.failureAttempts).toBe(0);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.nextAttemptAfter).toBeNull();
    expect(row.lastRunAt).not.toBeNull();
  });

  it('trips the circuit breaker after 10 consecutive failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    const past = new Date(Date.now() - 60_000);
    const db = getDb();
    const [proj] = await db
      .insert(schema.projects)
      .values({ slug: 'sched-pause', name: 'sched-pause' })
      .returning();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: proj.id,
        platformId: platform!.id,
        name: 'pause-c',
        skillSlug: 'reddit-scout',
        cronExpression: '* * * * *',
        nextAttemptAfter: past,
        failureAttempts: 9,
      })
      .returning();

    await schedulerTick();

    const [row] = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(row.failureAttempts).toBe(10);
    expect(row.pausedDueToFailures).toBe(true);
    // Once paused we clear next_attempt_after so the breaker is the sole gate.
    expect(row.nextAttemptAfter).toBeNull();

    const [notif] = await getDb()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, 'campaign.paused'));
    expect(notif).toBeTruthy();
    expect((notif.payload as { campaignId: number }).campaignId).toBe(campaign.id);
  });

  it('skips campaigns with paused_due_to_failures = true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const past = new Date(Date.now() - 60_000);
    const db = getDb();
    const [proj] = await db
      .insert(schema.projects)
      .values({ slug: 'sched-skip', name: 'sched-skip' })
      .returning();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    await db.insert(schema.campaigns).values({
      projectId: proj.id,
      platformId: platform!.id,
      name: 'skip-c',
      skillSlug: 'reddit-scout',
      cronExpression: '* * * * *',
      nextRunAt: past,
      pausedDueToFailures: true,
    });

    await schedulerTick();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
