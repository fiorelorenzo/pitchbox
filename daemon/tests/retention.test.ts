import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { loadRetention, saveRetention, RETENTION_FLOOR_DAYS } from '@pitchbox/shared/retention';
import { tick as retentionTick } from '../src/retention.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, run_events, draft_events, contact_history, notifications, app_config, webhook_deliveries RESTART IDENTITY CASCADE`,
  );
}

async function setupFixtures() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'ret-test', name: 'ret-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform!.id, handle: 'u/ret-test' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform!.id,
      name: 'ret-test',
      skillSlug: 'reddit-scout',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'campaign',
      campaignId: campaign.id,
      agentRunner: 'claude-code',
      trigger: 'manual',
      status: 'success',
    })
    .returning();
  return { proj, platform: platform!, account, campaign, run };
}

describe('retention worker', () => {
  beforeEach(async () => {
    await reset();
  });

  it('floors below-minimum values when saving policy', async () => {
    const saved = await saveRetention(getDb(), {
      drafts_days: 1,
      run_events_days: 0,
      draft_events_days: -50,
      webhook_deliveries_days: -1,
    });
    expect(saved.drafts_days).toBe(RETENTION_FLOOR_DAYS);
    expect(saved.run_events_days).toBe(RETENTION_FLOOR_DAYS);
    expect(saved.draft_events_days).toBe(RETENTION_FLOOR_DAYS);
    expect(saved.webhook_deliveries_days).toBe(RETENTION_FLOOR_DAYS);
    const loaded = await loadRetention(getDb());
    expect(loaded).toEqual(saved);
  });

  it('deletes old run_events / draft_events / terminal drafts and preserves contact_history', async () => {
    const { proj, platform, account, run } = await setupFixtures();
    const db = getDb();

    // Tight policy so we don't have to fabricate years-old timestamps.
    await saveRetention(db, { drafts_days: 7, run_events_days: 7, draft_events_days: 7 });

    const now = new Date();
    const ancient = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days
    const fresh = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day

    // Drafts: one old terminal (should die), one old pending_review (should survive),
    // one fresh terminal (should survive).
    const [oldSent] = await db
      .insert(schema.drafts)
      .values({
        runId: run.id,
        projectId: proj.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        state: 'sent',
        body: 'old sent',
        createdAt: ancient,
      })
      .returning();
    const [oldPending] = await db
      .insert(schema.drafts)
      .values({
        runId: run.id,
        projectId: proj.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        state: 'pending_review',
        body: 'old pending',
        createdAt: ancient,
      })
      .returning();
    const [freshSent] = await db
      .insert(schema.drafts)
      .values({
        runId: run.id,
        projectId: proj.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        state: 'sent',
        body: 'fresh sent',
        createdAt: fresh,
      })
      .returning();

    // contact_history points at the soon-to-be-deleted draft. The FK is
    // ON DELETE SET NULL, so the row itself must survive.
    await db.insert(schema.contactHistory).values({
      platformId: platform.id,
      accountHandle: account.handle,
      targetUser: 'someone',
      lastContactedAt: ancient,
      draftId: oldSent.id,
    });

    // run_events: one old (delete), one fresh (keep).
    await db.insert(schema.runEvents).values({
      runId: run.id,
      seq: 1,
      kind: 'log',
      payload: {},
      raw: 'old',
      createdAt: ancient,
    });
    await db.insert(schema.runEvents).values({
      runId: run.id,
      seq: 2,
      kind: 'log',
      payload: {},
      raw: 'fresh',
      createdAt: fresh,
    });

    // draft_events on a draft that itself survives, so we can verify the
    // event-level prune independent of cascade-from-draft deletion.
    await db.insert(schema.draftEvents).values({
      draftId: oldPending.id,
      event: 'note',
      actor: 'system',
      createdAt: ancient,
    });
    await db.insert(schema.draftEvents).values({
      draftId: oldPending.id,
      event: 'note',
      actor: 'system',
      createdAt: fresh,
    });

    const result = await retentionTick();

    expect(result.draftsDeleted).toBe(1);
    expect(result.runEventsDeleted).toBe(1);
    expect(result.draftEventsDeleted).toBe(1);

    const draftIds = (await db.select({ id: schema.drafts.id }).from(schema.drafts)).map(
      (r) => r.id,
    );
    expect(draftIds).not.toContain(oldSent.id);
    expect(draftIds).toContain(oldPending.id);
    expect(draftIds).toContain(freshSent.id);

    // contact_history survives even though its draft_id is now null.
    const ch = await db.select().from(schema.contactHistory);
    expect(ch).toHaveLength(1);
    expect(ch[0].draftId).toBeNull();

    const runEv = await db.select().from(schema.runEvents);
    expect(runEv).toHaveLength(1);
    expect(runEv[0].raw).toBe('fresh');

    const draftEv = await db.select().from(schema.draftEvents);
    expect(draftEv).toHaveLength(1);
  });

  it('prunes old delivered/dead webhook_deliveries and preserves pending + fresh rows', async () => {
    const db = getDb();

    // Tight policy so we don't have to fabricate years-old timestamps.
    await saveRetention(db, {
      drafts_days: 7,
      run_events_days: 7,
      draft_events_days: 7,
      webhook_deliveries_days: 7,
    });

    const now = new Date();
    const ancient = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days
    const fresh = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day

    const [oldDelivered] = await db
      .insert(schema.webhookDeliveries)
      .values({
        webhookId: 'wh-1',
        eventType: 'notification.test',
        payload: {},
        status: 'delivered',
        createdAt: ancient,
      })
      .returning();
    const [oldDead] = await db
      .insert(schema.webhookDeliveries)
      .values({
        webhookId: 'wh-1',
        eventType: 'notification.test',
        payload: {},
        status: 'dead',
        createdAt: ancient,
      })
      .returning();
    // Old but still pending - must survive, it is awaiting delivery, not terminal.
    const [oldPending] = await db
      .insert(schema.webhookDeliveries)
      .values({
        webhookId: 'wh-1',
        eventType: 'notification.test',
        payload: {},
        status: 'pending',
        createdAt: ancient,
      })
      .returning();
    // Fresh delivered - must survive, it is not old enough yet.
    const [freshDelivered] = await db
      .insert(schema.webhookDeliveries)
      .values({
        webhookId: 'wh-1',
        eventType: 'notification.test',
        payload: {},
        status: 'delivered',
        createdAt: fresh,
      })
      .returning();

    const result = await retentionTick();

    expect(result.webhookDeliveriesDeleted).toBe(2);

    const remainingIds = (
      await db.select({ id: schema.webhookDeliveries.id }).from(schema.webhookDeliveries)
    ).map((r) => r.id);
    expect(remainingIds).not.toContain(oldDelivered.id);
    expect(remainingIds).not.toContain(oldDead.id);
    expect(remainingIds).toContain(oldPending.id);
    expect(remainingIds).toContain(freshDelivered.id);
  });
});
