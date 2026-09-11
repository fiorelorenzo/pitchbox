import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAssistMcpServer } from '../../src/mcp/assist-server.js';
import { createPitchboxMcpServer } from '../../src/mcp/server.js';

// #567: the assist MCP entry point. What matters here, beyond `shared/tests/
// assist-tools.test.ts`'s coverage of the handlers themselves, is the
// transport contract: exactly the seven assist tools are advertised, none of
// the campaign server's, and the session-bound org plus the context file
// actually reach a handler through this server rather than only through a
// direct function call.

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE contact_history, projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function defaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'));
  return org!.id;
}

async function connectAssistClient(
  ctx: Parameters<typeof createAssistMcpServer>[0] = {},
): Promise<Client> {
  const server = createAssistMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-assist-client', version: '0.0.0' });
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

describe('cli/src/mcp/assist-server', () => {
  beforeEach(reset);

  it('advertises exactly the seven assist tools; the campaign server reuses three by name (LOR-224) and none of the other four', async () => {
    const orgId = await defaultOrgId();
    const assistClient = await connectAssistClient({ organizationId: orgId });
    const { tools } = await assistClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'author_history',
      'check_style',
      'look_at_image',
      'my_prior_takes',
      'operator_voice',
      'project_knowledge',
      'read_thread',
    ]);

    const campaignServer = createPitchboxMcpServer();
    const [campaignClientT, campaignServerT] = InMemoryTransport.createLinkedPair();
    await campaignServer.connect(campaignServerT);
    const campaignClient = new Client({ name: 'test-campaign-client', version: '0.0.0' });
    await campaignClient.connect(campaignClientT);
    const { tools: campaignTools } = await campaignClient.listTools();
    const campaignNames = new Set(campaignTools.map((t) => t.name));

    // LOR-224 deliberately reuses three read-only assist tools on the
    // campaign server, by name and by handler - this is the one intentional
    // overlap, and it is read-only (see the comment on their registration
    // in src/mcp/server.ts). The other four assist tools (observed-target
    // reads with no meaning on the campaign plane) must never appear there.
    const reused = ['operator_voice', 'my_prior_takes', 'check_style'];
    const assistOnly = names.filter((n) => !reused.includes(n));
    expect(assistOnly).toEqual([
      'author_history',
      'look_at_image',
      'project_knowledge',
      'read_thread',
    ]);
    for (const name of reused) expect(campaignNames.has(name)).toBe(true);
    for (const name of assistOnly) expect(campaignNames.has(name)).toBe(false);

    // And the reverse never happened either: no campaign write tool leaked
    // onto the assist server.
    expect(names).not.toContain('drafts_create');
    expect(names).not.toContain('run_finish');
  });

  it('refuses every tool call when the session has no bound organization', async () => {
    const client = await connectAssistClient({});
    const res = await call(client, 'check_style', { text: 'A clean sentence.' });
    expect(res.isError).toBe(true);
  });

  it('runs check_style end to end with no session binding required beyond org', async () => {
    const orgId = await defaultOrgId();
    const client = await connectAssistClient({ organizationId: orgId });
    const res = await call(client, 'check_style', { text: 'This is great \u2014 really great.' });
    expect(res.isError).toBeFalsy();
    const answer = parse(res) as { ok: boolean; data?: { findings: unknown[] } };
    expect(answer.ok).toBe(true);
    expect((answer.data?.findings ?? []).length).toBeGreaterThan(0);
  });

  it('reads the observed target from the context file for read_thread', async () => {
    const orgId = await defaultOrgId();
    const dir = mkdtempSync(join(tmpdir(), 'pitchbox-assist-mcp-test-'));
    const contextFile = join(dir, 'context.json');
    try {
      writeFileSync(
        contextFile,
        JSON.stringify({
          observedTarget: { text: 'A post read through the context file.', authorHandle: 'jdoe' },
          operator: null,
        }),
      );
      const client = await connectAssistClient({
        organizationId: orgId,
        contextFile,
      });
      const res = await call(client, 'read_thread', {});
      expect(res.isError).toBeFalsy();
      const answer = parse(res) as { ok: boolean; data?: { post: { text: string } } };
      expect(answer.ok).toBe(true);
      expect(answer.data?.post.text).toBe('A post read through the context file.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers read_thread with an explicit refusal when no context file was given', async () => {
    const orgId = await defaultOrgId();
    const client = await connectAssistClient({ organizationId: orgId });
    const res = await call(client, 'read_thread', {});
    expect(res.isError).toBeFalsy();
    const answer = parse(res) as { ok: boolean; reason?: string };
    expect(answer.ok).toBe(false);
  });
});

afterAll(async () => {
  await getPool().end();
});
