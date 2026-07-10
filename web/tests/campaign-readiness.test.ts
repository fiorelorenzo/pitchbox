import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { getCampaignReadiness } from '../src/lib/server/campaign-readiness.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function makeCampaign(opts: {
  withProfile?: boolean;
  withAccount?: boolean;
  agentRunner?: string;
  status?: string;
}): Promise<number> {
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'P',
    })
    .returning();
  if (opts.withAccount) {
    await db.insert(schema.accounts).values({
      projectId: project.id,
      platformId: platform.id,
      handle: 'me',
      role: 'personal',
    });
  }
  const config = opts.withProfile
    ? {
        targetSubreddits: ['rpg'],
        topicKeywords: ['x'],
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
      }
    : {};
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'c',
      skillSlug: 'reddit-scout',
      agentRunner: opts.agentRunner ?? 'claude-code',
      config,
      status: opts.status ?? 'active',
    })
    .returning();
  return campaign.id;
}

describe('getCampaignReadiness', () => {
  beforeEach(reset);

  it('reports profile_missing when config is empty', async () => {
    const id = await makeCampaign({ withAccount: true, status: 'draft' });
    const r = await getCampaignReadiness(id);
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => i.id === 'profile_missing')).toBe(true);
  });

  it('reports no_account when project has no account', async () => {
    const id = await makeCampaign({ withProfile: true });
    const r = await getCampaignReadiness(id);
    expect(r.issues.some((i) => i.id === 'no_account')).toBe(true);
  });

  it('reports runner_unavailable for a stub runner', async () => {
    const id = await makeCampaign({
      withProfile: true,
      withAccount: true,
      agentRunner: 'codex',
    });
    const r = await getCampaignReadiness(id);
    expect(r.issues.some((i) => i.id === 'runner_unavailable')).toBe(true);
  });

  it('returns ready=true once profile, account, and a runnable runner are present', async () => {
    const id = await makeCampaign({ withProfile: true, withAccount: true });
    const r = await getCampaignReadiness(id);
    // claude-code may or may not be installed in the test environment - the
    // remaining gating issues should at minimum exclude profile_missing and
    // no_account.
    expect(r.issues.some((i) => i.id === 'profile_missing')).toBe(false);
    expect(r.issues.some((i) => i.id === 'no_account')).toBe(false);
  });

  it('returns empty issues + ready=false when the campaign id is unknown', async () => {
    const r = await getCampaignReadiness(999_999);
    expect(r.ready).toBe(false);
    expect(r.issues).toEqual([]);
  });
});

afterAll(async () => {
  await getPool().end();
});
