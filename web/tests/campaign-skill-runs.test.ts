import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as adopt } from '../src/routes/api/campaigns/[id]/skill-runs/[runId]/adopt/+server.js';
import { POST as discard } from '../src/routes/api/campaigns/[id]/skill-runs/[runId]/discard/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function seedCampaignAndRun(generated: Record<string, unknown> | null) {
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [project] = await db
    .insert(schema.projects)
    .values({ slug: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'P' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'c',
      skillSlug: 'reddit-scout',
      agentRunner: 'claude-code',
      config: { previousMarker: true },
      status: 'draft',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'campaign_skill_generation',
      campaignId: campaign.id,
      agentRunner: 'claude-code',
      trigger: 'manual',
      status: 'success',
      params: {
        scenario: 'reddit-scout',
        objective: 'tighten the tone',
        mode: 'preview',
        previousConfig: { previousMarker: true },
        generatedConfig: generated,
      },
      finishedAt: new Date(),
    })
    .returning();
  return { campaignId: campaign.id, runId: run.id };
}

function eventFor(id: number, runId: number) {
  return { params: { id: String(id), runId: String(runId) } } as unknown as Parameters<
    typeof adopt
  >[0] &
    Parameters<typeof discard>[0];
}

describe('campaign skill-runs adopt/discard', () => {
  beforeEach(reset);

  it('adopt copies generatedConfig into campaign.config and flips draft → active', async () => {
    const generated = {
      targetSubreddits: ['rpg'],
      topicKeywords: ['foo'],
      avoidKeywords: [],
      fitScoreThreshold: 3,
      voice: {
        tone: 'casual',
        hardBans: [],
        dos: [],
        openerStyle: 'lowercase-casual',
        disclosure: 'i built this',
      },
      offer: { productUrl: 'https://example.com', subject: 'hi', text: 'pitch' },
      systemInstructions: 'be casual',
    };
    const { campaignId, runId } = await seedCampaignAndRun(generated);

    const res = await adopt(eventFor(campaignId, runId));
    expect(res.status).toBe(200);

    const db = getDb();
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(c.config).toEqual(generated);
    expect(c.status).toBe('active');

    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect((r.params as { adopted?: boolean }).adopted).toBe(true);
  });

  it('adopt returns 422 when the run has no generated config', async () => {
    const { campaignId, runId } = await seedCampaignAndRun(null);
    const res = await adopt(eventFor(campaignId, runId));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('no_generated_config');
  });

  it('discard marks the run discarded without touching campaign.config', async () => {
    const { campaignId, runId } = await seedCampaignAndRun({ targetSubreddits: ['x'] });
    const res = await discard(eventFor(campaignId, runId));
    expect(res.status).toBe(200);

    const db = getDb();
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(c.config).toEqual({ previousMarker: true });
    expect(c.status).toBe('draft');

    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect((r.params as { discarded?: boolean }).discarded).toBe(true);
  });
});

afterAll(async () => {
  await getPool().end();
});
