import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, { encoding: 'utf8', cwd: process.cwd() });
}
function cliWithStdin(args: string, input: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input,
    cwd: process.cwd(),
  });
}
function lastJson(out: string) {
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

let replyDraftId: number;
let runId: number;
let inboundId: number;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  await reset();
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'us' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  const [origin] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [parent] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'original',
      targetUser: 'them',
      state: 'sent',
    })
    .returning();
  const [contact] = await db
    .insert(schema.contactHistory)
    .values({
      platformId: platform.id,
      accountHandle: account.handle,
      targetUser: 'them',
      draftId: parent.id,
    })
    .returning();
  const [inbound] = await db
    .insert(schema.messages)
    .values({
      contactId: contact.id,
      draftId: parent.id,
      platformId: platform.id,
      author: 'them',
      isFromUs: false,
      body: 'tell me more',
      platformMessageId: 'm1',
      createdAtPlatform: new Date(),
      source: 'legacy',
    })
    .returning();
  inboundId = inbound.id;
  const [reply] = await db
    .insert(schema.drafts)
    .values({
      runId: origin.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'reply_dm',
      body: '[reply pending]',
      targetUser: 'them',
      state: 'pending_review',
      parentMessageId: inbound.id,
      sourceRef: { kind: 'reply', parentDraftId: parent.id, parentMessageId: inbound.id },
    })
    .returning();
  replyDraftId = reply.id;
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'reply_drafting',
      projectId: proj.id,
      trigger: 'manual',
      status: 'running',
      agentRunner: 'codex',
      params: { replyDraftId, parentMessageId: inbound.id },
    })
    .returning();
  runId = run.id;
  await db
    .update(schema.drafts)
    .set({ draftingRunId: run.id })
    .where(eq(schema.drafts.id, replyDraftId));
});

afterAll(async () => {
  await getPool().end();
});

describe('pitchbox drafts:reply:*', () => {
  it('start returns the placeholder, parent voice, chronological thread, and rubric template', () => {
    const parsed = lastJson(cli(`drafts:reply:start --run=${runId}`));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.replyDraftId).toBe(replyDraftId);
    expect(parsed.data.replyKind).toBe('reply_dm');
    expect(parsed.data.parent.body).toBe('original');
    expect(parsed.data.thread.length).toBe(1);
    expect(parsed.data.thread[0].body).toBe('tell me more');
    expect(parsed.data.parentMessageId).toBe(inboundId);
    expect(typeof parsed.data.rubricTemplate).toBe('string');
    expect(parsed.data.rubricTemplate.length).toBeGreaterThan(0);
  });

  it('finish sets the body, clears the flag, finalizes the run, and scores the reply', async () => {
    const out = cliWithStdin(
      `drafts:reply:finish --run=${runId}`,
      JSON.stringify({
        body: 'Happy to help - here is more.',
        qualityScore: 64,
        qualityReason: 'on tone',
      }),
    );
    expect(lastJson(out).ok).toBe(true);
    const db = getDb();
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, replyDraftId));
    expect(d.body).toBe('Happy to help - here is more.');
    expect(d.draftingRunId).toBeNull();
    expect(d.state).toBe('pending_review');
    expect(d.qualityScore).toBe(64);
    expect(d.qualityReason).toBe('on tone');
    expect(d.qualityModel).toBe('codex');
    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(r.status).toBe('success');
    const [evt] = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, replyDraftId));
    expect(evt.event).toBe('reply_drafted');
  });

  it('finish rejects an empty body', () => {
    expect(() =>
      cliWithStdin(`drafts:reply:finish --run=${runId}`, JSON.stringify({ body: '  ' })),
    ).toThrow();
  });
});
