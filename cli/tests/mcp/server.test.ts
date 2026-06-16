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

afterAll(async () => {
  await getPool().end();
});
