import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { recordVoiceSamples } from '@pitchbox/shared/operator-profile';
import { refreshVoiceProfile } from '@pitchbox/shared/operator-voice-profile';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPitchboxMcpServer } from '../../src/mcp/server.js';

// LOR-224: the campaign MCP server exposes three of the assist plane's seven
// read-only tools (operator_voice, my_prior_takes, check_style), reusing
// `shared/src/assist/tools.ts`'s own handlers rather than a second copy -
// see the comment on their registration in `src/mcp/server.ts`. This suite
// proves the campaign server's own wiring (context construction, org
// scoping, session binding), not the handlers themselves: `shared/tests/
// assist-tools.test.ts` already covers what each handler does with a given
// context, in depth.

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, operator_voice_profiles,
      operator_voice_samples, operator_profiles, messages, contact_history, templates
      RESTART IDENTITY CASCADE`,
  );
  // Org-scoping tests create extra organizations to prove cross-tenant
  // isolation; drop them between tests (the `default` org must survive).
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function redditPlatformId(): Promise<number> {
  const [p] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  return p!.id;
}

async function connectClientWithCtx(ctx: {
  runId?: number;
  campaignId?: number;
  projectId?: number;
}): Promise<Client> {
  const server = createPitchboxMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'lor-224-test', version: '0.0.0' });
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

/** Seeds a whole new organization with a project/account/campaign/run chain,
 * so a test can bind a campaign-server session to it via `runId`. */
async function seedOrgRun(slug: string) {
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
      name: 'Commenter',
      skillSlug: 'reddit-commenter',
      config: {},
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
    .returning();
  return {
    orgId: org.id,
    projectId: project.id,
    accountId: account.id,
    campaignId: campaign.id,
    runId: run.id,
  };
}

/** Three near-identical voice samples: enough to clear MIN_ITEMS_TO_DERIVE
 * (3) and to describe a real, non-empty voice profile - the same fixture
 * shape `shared/tests/operator-voice-profile.test.ts`'s own `seedCorpus`
 * uses, extended to a third item since that suite only needs two samples
 * (it adds a message and a draft to reach three; this one keeps everything
 * in `operator_voice_samples` for simplicity). */
async function seedMeasuredVoice(orgId: number, tag: string) {
  const platformId = await redditPlatformId();
  await recordVoiceSamples(getDb(), orgId, platformId, [
    {
      externalId: `${tag}-sample-1`,
      text: 'Just shipped campaign search today, the team is thrilled with results this week.',
    },
    {
      externalId: `${tag}-sample-2`,
      text: 'Just shipped the new onboarding flow, our team worked hard to get it right this quarter.',
    },
    {
      externalId: `${tag}-sample-3`,
      text: 'Just shipped a faster export path, the team is proud of how it turned out this sprint.',
    },
  ]);
  await refreshVoiceProfile(getDb(), orgId);
}

describe('campaign MCP server - LOR-224 (operator_voice, my_prior_takes, check_style)', () => {
  beforeEach(reset);

  it('advertises operator_voice, my_prior_takes and check_style alongside the write tools', async () => {
    const { runId } = await seedOrgRun('lor224-advertise');
    const client = await connectClientWithCtx({ runId });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('operator_voice');
    expect(names).toContain('my_prior_takes');
    expect(names).toContain('check_style');
    // Still the same write-capable plane - these three did not remove
    // drafts_create/run_finish, and did not gain arguments of their own
    // that could bypass org scoping (their schemas are the assist plane's
    // own, reused as-is).
    expect(names).toContain('drafts_create');
    expect(names).toContain('run_finish');
  });

  describe('operator_voice', () => {
    it('answers a measured voice for a run whose organization has one on file', async () => {
      const { orgId, runId } = await seedOrgRun('lor224-voice-measured');
      await seedMeasuredVoice(orgId, 'vm');
      const client = await connectClientWithCtx({ runId });
      const res = await call(client, 'operator_voice', {});
      expect(res.isError).toBeFalsy();
      const data = parse(res) as {
        ok: boolean;
        data: { voice: { status: string; summary: string } };
      };
      expect(data.ok).toBe(true);
      expect(data.data.voice.status).toBe('measured');
      expect(data.data.voice.summary).toContain('Just shipped');
    });

    it('answers an honest default rather than an invented voice when nothing is on file', async () => {
      const { runId } = await seedOrgRun('lor224-voice-thin');
      const client = await connectClientWithCtx({ runId });
      const res = await call(client, 'operator_voice', {});
      expect(res.isError).toBeFalsy();
      const data = parse(res) as {
        ok: boolean;
        data: { voice: { status: string; summary: string } };
      };
      expect(data.ok).toBe(true);
      expect(data.data.voice.status).toBe('default');
      expect(data.data.voice.summary.length).toBeGreaterThan(0);
    });

    it("never sees another organization's voice profile", async () => {
      const a = await seedOrgRun('lor224-voice-org-a');
      const b = await seedOrgRun('lor224-voice-org-b');
      await seedMeasuredVoice(b.orgId, 'vb');
      const client = await connectClientWithCtx({ runId: a.runId });
      const res = await call(client, 'operator_voice', {});
      const data = parse(res) as { ok: boolean; data: { voice: { status: string } } };
      expect(data.ok).toBe(true);
      expect(data.data.voice.status).toBe('default');
    });

    it('refuses when the session has no bound organization at all', async () => {
      const server = createPitchboxMcpServer({});
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: 'unbound', version: '0.0.0' });
      await client.connect(clientT);
      const res = await call(client, 'operator_voice', {});
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? '').toContain('bound to an organization');
    });
  });

  describe('my_prior_takes', () => {
    it('matches a real voice sample against a query naming its subject', async () => {
      const { orgId, runId } = await seedOrgRun('lor224-takes-match');
      const platformId = await redditPlatformId();
      await recordVoiceSamples(getDb(), orgId, platformId, [
        {
          externalId: 'takes-1',
          text: 'We just finished a big database migration this week.',
        },
      ]);
      const client = await connectClientWithCtx({ runId });
      const res = await call(client, 'my_prior_takes', { query: 'database migration' });
      expect(res.isError).toBeFalsy();
      const data = parse(res) as { ok: boolean; data: { matches: Array<{ excerpt: string }> } };
      expect(data.ok).toBe(true);
      expect(data.data.matches.length).toBeGreaterThan(0);
      expect(data.data.matches[0].excerpt).toContain('database migration');
    });

    it('refuses with an explicit nothing when nothing matches', async () => {
      const { runId } = await seedOrgRun('lor224-takes-empty');
      const client = await connectClientWithCtx({ runId });
      const res = await call(client, 'my_prior_takes', { query: 'quantum photosynthesis' });
      const data = parse(res) as { ok: boolean; reason?: string };
      expect(data.ok).toBe(false);
      expect(data.reason).toBeTruthy();
    });

    it("never returns another organization's prior writing", async () => {
      const a = await seedOrgRun('lor224-takes-org-a');
      const b = await seedOrgRun('lor224-takes-org-b');
      const platformId = await redditPlatformId();
      await recordVoiceSamples(getDb(), b.orgId, platformId, [
        {
          externalId: 'takes-b-1',
          text: "Org B's own database migration story, never seen by org A.",
        },
      ]);
      const client = await connectClientWithCtx({ runId: a.runId });
      const res = await call(client, 'my_prior_takes', { query: 'database migration' });
      const data = parse(res) as { ok: boolean };
      expect(data.ok).toBe(false);
    });
  });

  describe('check_style', () => {
    it('never refuses - a clean draft gets an empty findings list', async () => {
      const { runId } = await seedOrgRun('lor224-style-clean');
      const client = await connectClientWithCtx({ runId });
      const res = await call(client, 'check_style', { text: 'A clean, direct sentence.' });
      expect(res.isError).toBeFalsy();
      const data = parse(res) as { ok: boolean; data: { findings: unknown[] } };
      expect(data.ok).toBe(true);
      expect(data.data.findings).toEqual([]);
    });

    it('surfaces a real house-style finding for a body carrying a banned tell', async () => {
      const { runId } = await seedOrgRun('lor224-style-dirty');
      const client = await connectClientWithCtx({ runId });
      const res = await call(client, 'check_style', {
        text: 'Ever wondered why builds are slow\u2014ours got faster this week?',
      });
      expect(res.isError).toBeFalsy();
      const data = parse(res) as {
        ok: boolean;
        data: { findings: Array<{ ruleId: string }> };
      };
      expect(data.ok).toBe(true);
      expect(data.data.findings.map((f) => f.ruleId)).toContain('rhetorical-question-opener');
    });
  });
});

afterAll(async () => {
  await getPool().end();
});
