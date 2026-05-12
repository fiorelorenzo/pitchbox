import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import {
  CONTACTS_COLUMNS,
  CONVERSATIONS_COLUMNS,
  DRAFTS_COLUMNS,
  escapeCsvField,
  streamCsv,
} from '../src/lib/server/export-csv.js';

/**
 * Minimal RFC 4180 parser used purely to validate that what we produce
 * round-trips. Handles quoted fields with embedded commas, double-quotes
 * (escaped as ""), CR and LF.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush trailing field if any.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function reset() {
  // Truncate only tables the export touches. `platforms` is seeded and reused.
  await getDb().execute(
    sql`TRUNCATE messages, contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

describe('escapeCsvField', () => {
  it('returns plain text unquoted', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('quotes fields containing comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('escapes embedded double quotes per RFC 4180', () => {
    expect(escapeCsvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('quotes fields containing newlines', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('renders null/undefined as empty', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('formats Date as ISO string', () => {
    expect(escapeCsvField(new Date('2026-05-12T10:00:00Z'))).toBe('2026-05-12T10:00:00.000Z');
  });
});

describe('streamCsv', () => {
  beforeEach(reset);

  it('drafts: emits header in the documented column order', async () => {
    const res = streamCsv('drafts', new URLSearchParams('state=all'));
    const rows = parseCsv(await bodyOf(res));
    expect(rows[0]).toEqual([...DRAFTS_COLUMNS]);
  });

  it('drafts: maps columns and escapes tricky values', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: `p-${Date.now()}`, name: 'Proj' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'me',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'C',
        skillSlug: 'reddit-scout',
        agentRunner: 'claude-code',
        status: 'active',
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        campaignId: campaign.id,
        projectId: project.id,
        agentRunner: 'claude-code',
        trigger: 'manual',
        status: 'completed',
      })
      .returning();

    // A draft whose body contains a comma, a quote and a newline — every CSV
    // escape codepath should fire on this single row.
    const trickyBody = 'hello, "world"\nbye';
    await db.insert(schema.drafts).values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      state: 'pending_review',
      targetUser: 'someone',
      body: trickyBody,
      metadata: { subreddit: 'rpg' },
    });

    const res = streamCsv('drafts', new URLSearchParams('state=all'));
    const text = await bodyOf(res);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...DRAFTS_COLUMNS]);
    expect(rows.length).toBe(2);
    const row = rows[1];
    // id, created_at, state, platform, account_handle, target_user,
    // target_subreddit, campaign_id, run_id, body
    expect(row[2]).toBe('pending_review');
    expect(row[3]).toBe('reddit');
    expect(row[4]).toBe('me');
    expect(row[5]).toBe('someone');
    expect(row[6]).toBe('rpg');
    expect(row[7]).toBe(String(campaign.id));
    expect(row[8]).toBe(String(run.id));
    expect(row[9]).toBe(trickyBody);

    // And the raw stream must contain the quoted body verbatim.
    expect(text).toContain('"hello, ""world""\nbye"');
  });

  it('drafts: honors state and platform filters', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: `p-${Date.now()}`, name: 'P' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'a', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'C',
        skillSlug: 'reddit-scout',
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        campaignId: campaign.id,
        projectId: project.id,
        agentRunner: 'claude-code',
        trigger: 'manual',
      })
      .returning();
    await db.insert(schema.drafts).values([
      {
        runId: run.id,
        projectId: project.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        state: 'pending_review',
        body: 'x',
      },
      {
        runId: run.id,
        projectId: project.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        state: 'sent',
        body: 'y',
      },
    ]);

    const sentOnly = parseCsv(await bodyOf(streamCsv('drafts', new URLSearchParams('state=sent'))));
    // Header + 1 data row.
    expect(sentOnly.length).toBe(2);
    expect(sentOnly[1][2]).toBe('sent');

    const allRows = parseCsv(await bodyOf(streamCsv('drafts', new URLSearchParams('state=all'))));
    expect(allRows.length).toBe(3);
  });

  it('contacts: emits header and the documented column set', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    await db.insert(schema.contactHistory).values([
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'alice',
        lastContactedAt: new Date('2026-05-01T10:00:00Z'),
        repliedAt: new Date('2026-05-02T10:00:00Z'),
      },
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'alice',
        lastContactedAt: new Date('2026-05-05T10:00:00Z'),
      },
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'bob',
        lastContactedAt: new Date('2026-05-03T10:00:00Z'),
        replyCheckedAt: new Date('2026-05-04T10:00:00Z'),
      },
    ]);

    const rows = parseCsv(await bodyOf(streamCsv('contacts', new URLSearchParams())));
    expect(rows[0]).toEqual([...CONTACTS_COLUMNS]);
    expect(rows.length).toBe(4);

    // For (me, alice), first_contacted_at should be the earlier date even on
    // the later row.
    const aliceRows = rows.slice(1).filter((r) => r[3] === 'alice');
    expect(aliceRows.length).toBe(2);
    for (const r of aliceRows) {
      expect(r[4]).toBe('2026-05-01T10:00:00.000Z');
    }
    const replied = aliceRows.find((r) => r[6] === 'replied');
    expect(replied).toBeTruthy();

    const bob = rows.slice(1).find((r) => r[3] === 'bob');
    expect(bob?.[6]).toBe('no_reply');
  });

  it('contacts: filters by platform and q', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    await db.insert(schema.contactHistory).values([
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'alice_smith',
        lastContactedAt: new Date(),
      },
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'bob',
        lastContactedAt: new Date(),
      },
    ]);

    const rows = parseCsv(await bodyOf(streamCsv('contacts', new URLSearchParams('q=alice'))));
    expect(rows.length).toBe(2);
    expect(rows[1][3]).toBe('alice_smith');
  });

  it('conversations: emits header and aggregates message count', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: `p-${Date.now()}`, name: 'P' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'me', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'C',
        skillSlug: 'reddit-scout',
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        campaignId: campaign.id,
        projectId: project.id,
        agentRunner: 'claude-code',
        trigger: 'manual',
      })
      .returning();
    const [draft] = await db
      .insert(schema.drafts)
      .values({
        runId: run.id,
        projectId: project.id,
        platformId: platform.id,
        accountId: account.id,
        kind: 'dm',
        state: 'sent',
        body: 'hi',
      })
      .returning();
    const [contact] = await db
      .insert(schema.contactHistory)
      .values({
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'alice',
        draftId: draft.id,
        lastContactedAt: new Date('2026-05-01T10:00:00Z'),
        repliedAt: new Date('2026-05-02T10:00:00Z'),
        chatRoomId: '!room:reddit',
      })
      .returning();
    await db.insert(schema.messages).values([
      {
        contactId: contact.id,
        platformId: platform.id,
        author: 'me',
        isFromUs: true,
        body: 'hi',
        platformMessageId: 'm1',
        createdAtPlatform: new Date('2026-05-01T10:00:00Z'),
        source: 'test',
      },
      {
        contactId: contact.id,
        platformId: platform.id,
        author: 'alice',
        isFromUs: false,
        body: 'hello',
        platformMessageId: 'm2',
        createdAtPlatform: new Date('2026-05-02T10:00:00Z'),
        source: 'test',
      },
    ]);

    const rows = parseCsv(await bodyOf(streamCsv('conversations', new URLSearchParams())));
    expect(rows[0]).toEqual([...CONVERSATIONS_COLUMNS]);
    expect(rows.length).toBe(2);
    const row = rows[1];
    expect(row[0]).toBe('!room:reddit');
    expect(row[1]).toBe('me');
    expect(row[2]).toBe('alice');
    expect(row[3]).toBe('dm');
    expect(row[4]).toBe('2026-05-02T10:00:00.000Z');
    expect(row[5]).toBe('2');
  });

  it('conversations: filter=replied excludes awaiting rows', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    await db.insert(schema.contactHistory).values([
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'alice',
        lastContactedAt: new Date(),
        repliedAt: new Date(),
      },
      {
        platformId: platform.id,
        accountHandle: 'me',
        targetUser: 'bob',
        lastContactedAt: new Date(),
      },
    ]);

    const rows = parseCsv(
      await bodyOf(streamCsv('conversations', new URLSearchParams('filter=replied'))),
    );
    // Header + alice only.
    expect(rows.length).toBe(2);
    expect(rows[1][2]).toBe('alice');
  });

  it('Content-Disposition advertises a .csv attachment', async () => {
    const res = streamCsv('drafts', new URLSearchParams('state=all'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="drafts-.*\.csv"/);
  });
});

afterAll(async () => {
  await getPool().end();
});
