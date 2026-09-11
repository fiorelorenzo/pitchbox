import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { parseSharesCsv, parseCommentsCsv, parseMessagesCsv } from '@pitchbox/shared/voice-import';
// `pitchbox voice:import` (LOR-223): fills the voice corpus from a
// LinkedIn "Get a copy of your data" export headlessly. This exercises the
// real command function against Postgres - `voice-import.test.ts` in
// `shared/` already pins the pure parser's own edge cases; what only a real
// database can prove is dedup on re-import, organization resolution, and
// that a successful import re-derives the voice profile.
//
// FIXTURE NOTE: `SHARES_CSV`/`COMMENTS_CSV` below are byte-identical to the
// ones in `web/tests/companion-settings.test.ts`'s `importVoice` suite,
// kept in sync by hand since CLI and web are separate workspaces with no
// shared test-fixture module between them. Both suites assert their result
// against `parseSharesCsv`/`parseCommentsCsv` directly (the same functions
// `voiceImportRun` and the `importVoice` action both call under the hood),
// which is what actually proves the two paths cannot drift, rather than a
// literal string comparison across processes. `MESSAGES_CSV` (LOR-267) has
// no web equivalent - the companion page does not import messages.csv.
export const SHARES_CSV = [
  'Date,ShareLink,ShareCommentary',
  '2026-03-01,https://www.linkedin.com/feed/update/urn:li:activity:cli-1,Shipped the new export importer today.',
  '2026-03-02,https://www.linkedin.com/feed/update/urn:li:activity:cli-2,',
  '2026-03-03,https://www.linkedin.com/feed/update/urn:li:activity:cli-3,Wrapped up a long week of onboarding fixes.',
].join('\n');

export const COMMENTS_CSV = [
  'Date,Link,Message',
  '2026-03-01,https://www.linkedin.com/feed/update/urn:li:activity:cli-10,Nice work on this.',
  '2026-03-02,https://www.linkedin.com/feed/update/urn:li:activity:cli-11,Love this.',
  '2026-03-03,https://www.linkedin.com/feed/update/urn:li:activity:cli-12,So true.',
].join('\n');

// Two conversations so the operator (party to both) is decisively
// distinguishable from either correspondent (party to only their own) -
// see shared/tests/voice-import.test.ts's own fixture comment.
export const MESSAGES_CSV = [
  'CONVERSATION ID,SENDER PROFILE URL,CONTENT,IS MESSAGE DRAFT',
  'cli-conv-1,https://www.linkedin.com/in/cli-other,Hi there,No',
  'cli-conv-1,https://www.linkedin.com/in/cli-operator,Good to hear from you,No',
  'cli-conv-2,https://www.linkedin.com/in/cli-operator,Following up on our chat,No',
  'cli-conv-2,https://www.linkedin.com/in/cli-operator,Draft I never sent,Yes',
].join('\n');

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE operator_voice_samples, operator_voice_messages, operator_voice_profiles RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function ensureOrg(slug: string): Promise<number> {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org!.id;
}

beforeEach(reset);

describe('voiceImportRun', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-import-cli-'));
  });

  it('imports Shares.csv into the default organization when --org is omitted', async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const path = join(dir, 'Shares.csv');
    await writeFile(path, SHARES_CSV, 'utf8');

    const result = await voiceImportRun({ path });
    const expected = parseSharesCsv(SHARES_CSV);
    expect(result.parsed).toBe(expected.length);
    expect(result.inserted).toBe(expected.length);
    expect(result.byGenre).toEqual({ post: expected.length, comment: 0 });

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, result.organizationId));
    expect(rows.map((r) => r.text).sort()).toEqual(expected.map((i) => i.text).sort());
    expect(rows.every((r) => r.genre === 'post' && r.source === 'import')).toBe(true);
  });

  it('imports Comments.csv, tagging genre comment and carrying context', async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const orgId = await ensureOrg('voice-cli-comments');
    const path = join(dir, 'Comments.csv');
    await writeFile(path, COMMENTS_CSV, 'utf8');

    const result = await voiceImportRun({ path, org: 'voice-cli-comments' });
    expect(result.organizationId).toBe(orgId);
    const expected = parseCommentsCsv(COMMENTS_CSV);
    expect(result.byGenre).toEqual({ post: 0, comment: expected.length });

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgId));
    expect(rows).toHaveLength(expected.length);
    for (const row of rows) {
      expect(row.genre).toBe('comment');
      expect(row.context).not.toBeNull();
    }
  });

  it("imports messages.csv, keeping only the operator's own non-draft rows", async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const orgId = await ensureOrg('voice-cli-messages');
    const path = join(dir, 'messages.csv');
    await writeFile(path, MESSAGES_CSV, 'utf8');

    const result = await voiceImportRun({ path, org: 'voice-cli-messages' });
    const expected = parseMessagesCsv(MESSAGES_CSV);
    expect(expected).toHaveLength(2);
    expect(result.messages.parsed).toBe(2);
    expect(result.messages.inserted).toBe(2);
    // Nothing lands as a post/comment voice sample from this file.
    expect(result.inserted).toBe(0);
    expect(result.byGenre).toEqual({ post: 0, comment: 0 });

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceMessages)
      .where(eq(schema.operatorVoiceMessages.organizationId, orgId));
    expect(rows.map((r) => r.text).sort()).toEqual(expected.map((i) => i.text).sort());
    // Never touches operator_voice_samples - a DM has no post/comment genre.
    const samples = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgId));
    expect(samples).toHaveLength(0);
  });

  it('running the same messages.csv import twice inserts nothing the second time', async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const orgId = await ensureOrg('voice-cli-messages-dedup');
    const path = join(dir, 'messages.csv');
    await writeFile(path, MESSAGES_CSV, 'utf8');

    const first = await voiceImportRun({ path, org: 'voice-cli-messages-dedup' });
    expect(first.messages.inserted).toBe(2);

    const second = await voiceImportRun({ path, org: 'voice-cli-messages-dedup' });
    expect(second.messages.parsed).toBe(first.messages.parsed);
    expect(second.messages.inserted).toBe(0);

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceMessages)
      .where(eq(schema.operatorVoiceMessages.organizationId, orgId));
    expect(rows).toHaveLength(2);
  });

  it('running the same import twice inserts nothing the second time', async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const orgId = await ensureOrg('voice-cli-dedup');
    const path = join(dir, 'Shares.csv');
    await writeFile(path, SHARES_CSV, 'utf8');

    const first = await voiceImportRun({ path, org: 'voice-cli-dedup' });
    expect(first.inserted).toBeGreaterThan(0);

    const second = await voiceImportRun({ path, org: 'voice-cli-dedup' });
    expect(second.parsed).toBe(first.parsed);
    expect(second.inserted).toBe(0);

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgId));
    expect(rows).toHaveLength(first.inserted);
  });

  it('re-derives the voice profile after a successful import', async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const orgId = await ensureOrg('voice-cli-refresh');
    const path = join(dir, 'Shares.csv');
    await writeFile(path, SHARES_CSV, 'utf8');

    await voiceImportRun({ path, org: 'voice-cli-refresh' });

    const [profile] = await getDb()
      .select()
      .from(schema.operatorVoiceProfiles)
      .where(eq(schema.operatorVoiceProfiles.organizationId, orgId));
    expect(profile).toBeDefined();
    expect(profile.source).toBe('derived');
  });

  it('rejects an unknown --org rather than silently importing into the default organization', async () => {
    const { voiceImportRun } = await import('../../src/commands/voice.js');
    const path = join(dir, 'Shares.csv');
    await writeFile(path, SHARES_CSV, 'utf8');
    await expect(voiceImportRun({ path, org: 'no-such-org' })).rejects.toThrow(
      /Unknown organization/,
    );
  });
});
