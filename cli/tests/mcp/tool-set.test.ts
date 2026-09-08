import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPitchboxMcpServer } from '../../src/mcp/server.js';
import { createPitchboxToolSet } from '../../src/mcp/tool-set.js';

// This suite proves the bridge in src/mcp/tool-set.ts, not the Pitchbox MCP
// server's own tool behaviour (that is server.test.ts's job, in this same
// directory). Each test exercises a real Postgres row through the real AI
// SDK tool set - the point of #417 is that the tool list and the
// org/ownership enforcement are inherited from src/mcp/server.ts by
// construction, so a test that mocked the MCP layer would prove nothing.
//
// shared/src/agents/sdk/tools.ts re-exports createPitchboxToolSet from here
// via a lazy import() (mirroring shared/src/agents/cloud.ts's private
// cloud-adapter loader) so `shared` stays a leaf workspace with no
// dependency on `cli`. That loader has no behaviour of its own to test - it
// only resolves this module and delegates - so the real coverage lives here,
// against the concrete implementation.

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

type ToolExecuteOptions = {
  toolCallId: string;
  messages: unknown[];
};

type ToolExecute = (
  input: Record<string, unknown>,
  options: ToolExecuteOptions,
) => Promise<ToolCallResult>;

function executable(tools: Record<string, unknown>, name: string): ToolExecute {
  const tool = tools[name] as { execute?: unknown } | undefined;
  if (!tool || typeof tool.execute !== 'function') {
    throw new Error(`tool set has no executable tool named "${name}"`);
  }
  return tool.execute.bind(tool) as ToolExecute;
}

async function call(
  tools: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return executable(tools, name)(args, { toolCallId: `test-${name}`, messages: [] });
}

function parse(res: ToolCallResult): unknown {
  return JSON.parse(res.content[0]?.text ?? 'null');
}

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, staging_scout_candidates RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function redditPlatformId(): Promise<number> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, 'reddit'));
  return p.id;
}

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

/** Seeds a whole new organization (project + account + scout campaign), so two
 * calls with different slugs give two orgs whose ids never collide. */
async function seedOrgScoutCampaign(slug: string) {
  const db = getDb();
  const platformId = await redditPlatformId();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `${slug}-proj`, name: `${slug} project` })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId, handle: `${slug}-acc`, role: 'personal' })
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
  return {
    orgId: org.id,
    projectId: project.id,
    accountId: account.id,
    campaignId: campaign.id,
  };
}

describe('createPitchboxToolSet', () => {
  beforeEach(async () => {
    await reset();
  });

  it('exposes the same tool list the ACP path sees', async () => {
    // The ACP path connects a fresh createPitchboxMcpServer() to its own
    // in-memory pair and lists its tools directly - the reference this test
    // compares against, rather than a hardcoded array of names that could
    // drift from the real registration code.
    const referenceServer = createPitchboxMcpServer();
    const [refClientT, refServerT] = InMemoryTransport.createLinkedPair();
    await referenceServer.connect(refServerT);
    const referenceClient = new Client({ name: 'reference', version: '0.0.0' });
    await referenceClient.connect(refClientT);
    const { tools: referenceTools } = await referenceClient.listTools();
    const referenceNames = referenceTools.map((t) => t.name).sort();
    await referenceClient.close();

    const toolSet = await createPitchboxToolSet();
    try {
      const bridgedNames = Object.keys(toolSet.tools).sort();
      expect(bridgedNames).toEqual(referenceNames);
      expect(bridgedNames.length).toBeGreaterThan(0);
    } finally {
      await toolSet.close();
    }
  });

  it('drafts_create writes a real draft with the session-bound project and run ids', async () => {
    const { campaignId, accountId, projectId } = await seedOrgScoutCampaign('sdk-write');
    const toolSet = await createPitchboxToolSet({ campaignId });
    try {
      const { runId } = parse(await call(toolSet.tools, 'run_start', {})) as { runId: number };
      expect(runId).toBeGreaterThan(0);

      const res = await call(toolSet.tools, 'drafts_create', {
        runId,
        drafts: [
          { accountId, kind: 'dm', targetUser: 'good-guy', body: 'hey, nice post', fitScore: 4 },
        ],
      });
      expect(res.isError).toBeFalsy();
      const data = parse(res) as { inserted: number };
      expect(data.inserted).toBe(1);

      const db = getDb();
      const rows = await db.select().from(schema.drafts).where(eq(schema.drafts.runId, runId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.runId).toBe(runId);
      expect(rows[0]?.projectId).toBe(projectId);
      expect(rows[0]?.targetUser).toBe('good-guy');
    } finally {
      await toolSet.close();
    }
  });

  it("cannot write into another organization's run", async () => {
    const a = await seedOrgScoutCampaign('sdk-org-a');
    const b = await seedOrgScoutCampaign('sdk-org-b');

    const toolSetA = await createPitchboxToolSet({ campaignId: a.campaignId });
    const toolSetB = await createPitchboxToolSet({ campaignId: b.campaignId });
    try {
      const { runId: runIdB } = parse(await call(toolSetB.tools, 'run_start', {})) as {
        runId: number;
      };

      // Session A tries to write a draft into session B's run by overriding
      // the runId argument - the ownership check must catch this even though
      // the argument itself is well-formed.
      const res = await call(toolSetA.tools, 'drafts_create', {
        runId: runIdB,
        drafts: [{ accountId: a.accountId, kind: 'dm', targetUser: 'x', body: 'y', fitScore: 3 }],
      });

      // A usable error returned to the caller, not a thrown exception - the
      // whole point (docs/cloud-runner.md, "#417 has to keep").
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? '').toContain(
        "does not belong to this session's organization",
      );

      const db = getDb();
      const rows = await db.select().from(schema.drafts).where(eq(schema.drafts.runId, runIdB));
      expect(rows).toHaveLength(0);
    } finally {
      await toolSetA.close();
      await toolSetB.close();
    }
  });

  it('a tool whose command throws returns a usable error instead of an exception', async () => {
    // Reproduces the exact case the #415 spike hit: a campaign config that
    // fails the scenario's structured-format validation makes startRun()
    // throw a raw Error; the MCP handler's own try/catch turns that into an
    // isError result. What this test proves at the #417 boundary is that the
    // AI SDK's execute() surfaces that as a returned result, not a rejected
    // promise that would kill stopWhen's loop.
    const db = getDb();
    const platformId = await redditPlatformId();
    const [org] = await db
      .insert(schema.organizations)
      .values({ slug: 'sdk-bad-config', name: 'sdk-bad-config' })
      .returning();
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'sdk-bad-config-proj', name: 'bad config project' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId,
        name: 'Bad Config Scout',
        skillSlug: 'reddit-scout',
        // Not the structured SCOUT_PROFILE shape - fails scenarioSchema.safeParse.
        config: { legacy: true },
      })
      .returning();

    const toolSet = await createPitchboxToolSet({ campaignId: campaign.id });
    try {
      const res = await call(toolSet.tools, 'run_start', {});
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? '').toContain('structured format');
    } finally {
      await toolSet.close();
    }
  });

  it('close() releases both ends: a call after close fails rather than hanging', async () => {
    const { campaignId } = await seedOrgScoutCampaign('sdk-close');
    const toolSet = await createPitchboxToolSet({ campaignId });
    await toolSet.close();

    // A genuine wall-clock race, deliberately: the property under test is
    // "does not hang forever", and there is no event to await instead - a
    // closed InMemoryTransport either rejects promptly (pass) or the call
    // never settles (the failure this guards against). vitest's own test
    // timeout would eventually catch a hang too, but with a generic timeout
    // failure rather than naming what happened.
    const outcome = await Promise.race([
      call(toolSet.tools, 'run_start', {}).then(
        () => 'resolved' as const,
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('call after close() hung instead of failing')), 3000),
      ),
    ]);
    expect(outcome).toBeInstanceOf(Error);
  });
});

afterAll(async () => {
  await getPool().end();
});
