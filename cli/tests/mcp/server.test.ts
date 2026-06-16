import { describe, expect, it, beforeEach, afterAll } from 'vitest';
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
  const [project] = await db
    .insert(schema.projects)
    .values({ slug: 'mcp-test', name: 'MCP Test' })
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

afterAll(async () => {
  await getPool().end();
});
