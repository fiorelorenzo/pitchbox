import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPitchboxMcpServer } from '../../src/mcp/server.js';
import {
  checkBlocklist,
  checkContactHistory,
  getStagingCandidates,
} from '../../src/commands/utility.js';

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, staging_scout_candidates RESTART IDENTITY CASCADE`,
  );
}

async function redditPlatformId(): Promise<number> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, 'reddit'));
  return p.id;
}

async function connectClient(): Promise<Client> {
  const server = createPitchboxMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as CallResult;
}

function parse(res: CallResult): unknown {
  return JSON.parse(res.content[0]?.text ?? 'null');
}

describe('pitchbox MCP server (read-only tools)', () => {
  beforeEach(async () => {
    await reset();
  });

  it('advertises the read-only tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('blocklist_check');
    expect(names).toContain('contact_history_check');
    expect(names).toContain('staging_candidates');
  });

  it('blocklist_check returns blocked=false for an unlisted user', async () => {
    const client = await connectClient();
    const res = await call(client, 'blocklist_check', { platform: 'reddit', user: 'nobody' });
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ blocked: false, reason: null });
  });

  it('blocklist_check returns blocked=true with the reason for a listed user', async () => {
    const pid = await redditPlatformId();
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: pid, kind: 'user', value: 'spammer', reason: 'spam' });
    const client = await connectClient();
    const res = await call(client, 'blocklist_check', { platform: 'reddit', user: 'spammer' });
    expect(parse(res)).toEqual({ blocked: true, reason: 'spam' });
  });

  it('blocklist_check surfaces an unknown platform as a tool error', async () => {
    const client = await connectClient();
    const res = await call(client, 'blocklist_check', { platform: 'nope', user: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text ?? '').toContain('not found');
  });

  it('contact_history_check reports a prior contact', async () => {
    const pid = await redditPlatformId();
    await getDb()
      .insert(schema.contactHistory)
      .values({ platformId: pid, accountHandle: 'alice', targetUser: 'reached' });
    const client = await connectClient();
    const res = await call(client, 'contact_history_check', {
      platform: 'reddit',
      target: 'reached',
    });
    const data = parse(res) as { contacted: boolean; lastContactedAt: string | null };
    expect(data.contacted).toBe(true);
    expect(data.lastContactedAt).toBeTruthy();
  });

  it('contact_history_check reports no prior contact for an unknown target', async () => {
    const client = await connectClient();
    const res = await call(client, 'contact_history_check', {
      platform: 'reddit',
      target: 'stranger',
    });
    expect(parse(res)).toEqual({ contacted: false, lastContactedAt: null });
  });

  it('staging_candidates returns [] for a run with no staged candidates', async () => {
    const client = await connectClient();
    const res = await call(client, 'staging_candidates', { run: 999999 });
    expect(parse(res)).toEqual([]);
  });

  it('exposes the extracted functions for direct reuse', async () => {
    expect(await getStagingCandidates(999999)).toEqual([]);
    await expect(checkBlocklist('nope', 'x')).rejects.toThrow(/not found/);
    expect(await checkContactHistory('reddit', 'stranger')).toEqual({
      contacted: false,
      lastContactedAt: null,
    });
  });
});

const SCOUT_PROFILE = {
  targetSubreddits: ['rpg'],
  topicKeywords: ['ai dm'],
  avoidKeywords: [],
  fitScoreThreshold: 3,
  voice: {
    tone: 'casual',
    hardBans: [],
    dos: [],
    openerStyle: 'lowercase-casual',
    disclosure: 'i build this',
  },
  offer: { productUrl: 'https://example.com', subject: 'invite', text: 'short pitch' },
  systemInstructions: 'casual tone',
};

async function seedScoutCampaign() {
  const db = getDb();
  const platformId = await redditPlatformId();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'mcp-test', name: 'MCP Test' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId, handle: 'alice', role: 'personal' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId,
      name: 'Scout',
      skillSlug: 'reddit-scout',
      config: SCOUT_PROFILE,
    })
    .returning();
  return { projectId: project.id, accountId: account.id, campaignId: campaign.id, platformId };
}

describe('pitchbox MCP server (lifecycle + write tools)', () => {
  beforeEach(async () => {
    await reset();
  });

  it('run_start creates a run and returns campaign context', async () => {
    const { campaignId } = await seedScoutCampaign();
    const client = await connectClient();
    const res = await call(client, 'run_start', { campaignId });
    const data = parse(res) as {
      runId: number;
      campaign: { name: string };
      platform: { slug: string };
      accounts: { handle: string }[];
    };
    expect(data.runId).toBeGreaterThan(0);
    expect(data.campaign.name).toBe('Scout');
    expect(data.platform.slug).toBe('reddit');
    expect(data.accounts[0]?.handle).toBe('alice');
  });

  it('run_start defaults the campaign id to PITCHBOX_CAMPAIGN_ID', async () => {
    const { campaignId } = await seedScoutCampaign();
    process.env.PITCHBOX_CAMPAIGN_ID = String(campaignId);
    try {
      const client = await connectClient();
      const res = await call(client, 'run_start', {});
      expect((parse(res) as { runId: number }).runId).toBeGreaterThan(0);
    } finally {
      delete process.env.PITCHBOX_CAMPAIGN_ID;
    }
  });

  it('run_start binds the campaign from an explicit context (no env)', async () => {
    const { campaignId } = await seedScoutCampaign();
    const server = createPitchboxMcpServer({ campaignId });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'ctx', version: '0.0.0' });
    await client.connect(clientT);
    const res = await call(client, 'run_start', {});
    expect((parse(res) as { runId: number }).runId).toBeGreaterThan(0);
  });

  it('run_start errors when no campaign id is available', async () => {
    const client = await connectClient();
    const res = await call(client, 'run_start', {});
    expect(res.isError).toBe(true);
  });

  it('run_finish marks the run finished', async () => {
    const { campaignId } = await seedScoutCampaign();
    const client = await connectClient();
    const { runId } = parse(await call(client, 'run_start', { campaignId })) as { runId: number };
    const res = await call(client, 'run_finish', { runId, status: 'success' });
    expect(parse(res)).toEqual({ runId, status: 'success' });
    const db = getDb();
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(row.status).toBe('success');
    expect(row.finishedAt).toBeTruthy();
  });

  it('drafts_create persists drafts and skips blocklisted targets', async () => {
    const { campaignId, accountId, platformId } = await seedScoutCampaign();
    const db = getDb();
    await db
      .insert(schema.blocklist)
      .values({ platformId, kind: 'user', value: 'blocked-guy', reason: 'spam' });
    const client = await connectClient();
    const { runId } = parse(await call(client, 'run_start', { campaignId })) as { runId: number };
    const res = await call(client, 'drafts_create', {
      runId,
      drafts: [
        { accountId, kind: 'dm', targetUser: 'good-guy', body: 'hey, nice post', fitScore: 4 },
        { accountId, kind: 'dm', targetUser: 'blocked-guy', body: 'hey there', fitScore: 4 },
      ],
    });
    const data = parse(res) as { inserted: number; skipped: { targetUser: string }[] };
    expect(data.inserted).toBe(1);
    expect(data.skipped.map((s) => s.targetUser)).toContain('blocked-guy');
    const rows = await db.select().from(schema.drafts).where(eq(schema.drafts.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetUser).toBe('good-guy');
  });

  it('reddit_scout surfaces an unknown run as a tool error', async () => {
    const client = await connectClient();
    const res = await call(client, 'reddit_scout', { runId: 987654 });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text ?? '').toContain('not found');
  });
});

describe('pitchbox MCP server (project + skill tools)', () => {
  beforeEach(async () => {
    await reset();
  });

  it('project_extract_start exposes the source path; finish persists the description', async () => {
    const db = getDb();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'extract', name: 'Extract' })
      .returning();
    const dir = mkdtempSync(join(tmpdir(), 'pb-src-'));
    writeFileSync(join(dir, 'README.md'), '# Cool Product\nDoes things.', 'utf8');
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: dir } },
      })
      .returning();

    const client = await connectClient();
    const start = parse(await call(client, 'project_extract_start', { runId: run.id })) as {
      sourcePath: string;
      scenarios: unknown[];
    };
    expect(start.sourcePath).toBe(dir);
    expect(start.scenarios.length).toBeGreaterThan(0);

    const fin = parse(
      await call(client, 'project_extract_finish', {
        runId: run.id,
        description: '## Overview\nGreat product for RPG players.',
        recommendations: [
          { scenarioSlug: 'reddit-scout', name: 'Launch', objective: 'reach rpg folks' },
        ],
      }),
    ) as { recommendations: number };
    expect(fin.recommendations).toBe(1);

    const [p2] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(p2?.description).toContain('Great product');
    const [r2] = await db.select().from(schema.runs).where(eq(schema.runs.id, run.id));
    expect(r2?.status).toBe('success');
  });

  it('project_insights_context reports counts; project_insights persists a summary', async () => {
    const db = getDb();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'ins', name: 'Ins' })
      .returning();
    const client = await connectClient();
    const ctx = parse(
      await call(client, 'project_insights_context', { projectId: project.id }),
    ) as {
      draftCount: number;
      projectName: string;
    };
    expect(ctx.draftCount).toBe(0);
    expect(ctx.projectName).toBe('Ins');
    const ins = parse(
      await call(client, 'project_insights', {
        projectId: project.id,
        summaryMd: '## Insights\n- a pattern (draft #1)',
        evidence: { draftIds: [1] },
      }),
    ) as { id: number };
    expect(ins.id).toBeGreaterThan(0);
  });

  it('skill_generate validates the profile: invalid is a tool error, valid writes config', async () => {
    const db = getDb();
    const platformId = await redditPlatformId();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'skill', name: 'Skill', description: 'desc' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId,
        name: 'C',
        skillSlug: 'reddit-scout',
        status: 'draft',
        config: {},
      })
      .returning();
    const mkRun = async () =>
      (
        await db
          .insert(schema.runs)
          .values({
            kind: 'campaign_skill_generation',
            campaignId: campaign.id,
            trigger: 'manual',
            status: 'running',
            params: { scenario: 'reddit-scout', objective: 'reach rpg folks', mode: 'apply' },
          })
          .returning()
      )[0];

    const run = await mkRun();
    const client = await connectClient();
    const start = parse(await call(client, 'skill_generate_start', { runId: run.id })) as {
      scenario: string;
      objective: string;
    };
    expect(start.scenario).toBe('reddit-scout');
    expect(start.objective).toContain('rpg');

    const bad = await call(client, 'skill_generate_finish', {
      runId: run.id,
      profile: { foo: 'bar' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text ?? '').toContain('validation');

    const run2 = await mkRun();
    const okRes = parse(
      await call(client, 'skill_generate_finish', { runId: run2.id, profile: SCOUT_PROFILE }),
    ) as { status: string };
    expect(okRes.status).toBe('success');
    const [c2] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(c2?.status).toBe('active');
    expect((c2?.config as { targetSubreddits?: unknown }).targetSubreddits).toBeDefined();
  });
});

describe('pitchbox MCP server (drafts_get / drafts_update / subreddit_snapshot)', () => {
  beforeEach(async () => {
    await reset();
  });

  it('advertises subreddit_snapshot, drafts_get and drafts_update', async () => {
    const client = await connectClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('subreddit_snapshot');
    expect(names).toContain('drafts_get');
    expect(names).toContain('drafts_update');
  });

  it('drafts_get fetches a draft with messages; drafts_update overwrites the body', async () => {
    const { campaignId, accountId } = await seedScoutCampaign();
    const client = await connectClient();
    const { runId } = parse(await call(client, 'run_start', { campaignId })) as { runId: number };
    await call(client, 'drafts_create', {
      runId,
      drafts: [{ accountId, kind: 'dm', targetUser: 'bob', body: 'original body', fitScore: 3 }],
    });
    const db = getDb();
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.runId, runId));

    const got = parse(await call(client, 'drafts_get', { id: d!.id })) as {
      draft: { id: number; body: string };
      messages: unknown[];
    };
    expect(got.draft.id).toBe(d!.id);
    expect(got.draft.body).toBe('original body');
    expect(Array.isArray(got.messages)).toBe(true);

    const upd = parse(
      await call(client, 'drafts_update', { id: d!.id, body: 'rewritten reply' }),
    ) as {
      updated: boolean;
    };
    expect(upd.updated).toBe(true);
    const [d2] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, d!.id));
    expect(d2?.body).toBe('rewritten reply');
  });

  it('drafts_get errors on an unknown id', async () => {
    const client = await connectClient();
    const res = await call(client, 'drafts_get', { id: 999999 });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text ?? '').toContain('not found');
  });
});

describe('pitchbox MCP server (hn_search)', () => {
  it('advertises hn_search', async () => {
    const client = await connectClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('hn_search');
  });

  it('returns structured Hacker News items (live)', async () => {
    const client = await connectClient();
    const res = await call(client, 'hn_search', { listing: 'top', limit: 3 });
    expect(res.isError).toBeFalsy();
    const data = parse(res) as { count: number; items: Array<{ id: unknown; title: unknown }> };
    expect(typeof data.count).toBe('number');
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeLessThanOrEqual(3);
    if (data.items[0]) expect(data.items[0]).toHaveProperty('title');
  });
});

afterAll(async () => {
  await getPool().end();
});
