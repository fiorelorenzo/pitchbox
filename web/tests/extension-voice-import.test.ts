import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as voiceImportPost } from '../src/routes/api/extension/voice-import/+server.js';

/**
 * POST /api/extension/voice-import (LOR-245): the LinkedIn export importer
 * as a real HTTP endpoint, device-token-authed like every other
 * /api/extension/* route. Modelled on extension-observations.test.ts's own
 * seeding/mintDevice harness, plus the raw-binary-body and CSV/zip-fixture
 * concerns specific to this route.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE operator_voice_samples, operator_voice_profiles RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // A plain DELETE, not TRUNCATE ... RESTART IDENTITY: the route's rate
  // limiter is keyed by numeric device id (see extension-observations.test.ts's
  // own note on this), so resetting the id sequence would collide two
  // tests' devices into the same in-memory bucket.
  await getDb().execute(sql`DELETE FROM extension_devices`);
}

function rawRequest(token: string | null, contentType: string | null, body: Buffer): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (contentType) headers['content-type'] = contentType;
  const bytes = Uint8Array.from(body);
  return new Request('http://x/api/extension/voice-import', {
    method: 'POST',
    headers,
    body: bytes,
  });
}

async function seedOrg(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  return org;
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({
      organizationId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      label: 'test',
    });
}

// Shares.csv: one real post, one bare repost (empty ShareCommentary) that
// must be skipped rather than imported as an empty post.
const SHARES_CSV =
  'Date,ShareLink,ShareCommentary\n' +
  '2026-01-01T00:00:00Z,https://www.linkedin.com/posts/1,"A real post about outreach automation."\n' +
  '2026-01-02T00:00:00Z,https://www.linkedin.com/posts/2,\n' +
  '2026-01-03T00:00:00Z,https://www.linkedin.com/posts/3,"Another post with something to say."\n';

// Comments.csv: one real comment, one bare reaction (empty Message).
const COMMENTS_CSV =
  'Date,Link,Message\n' +
  '2026-01-01T00:00:00Z,https://www.linkedin.com/posts/10,"Great point about cold outreach!"\n' +
  '2026-01-02T00:00:00Z,https://www.linkedin.com/posts/11,\n';

function buildExportZip(opts: { shares?: string; comments?: string } = {}): Buffer {
  const zip = new AdmZip();
  if (opts.shares !== undefined) zip.addFile('Shares.csv', Buffer.from(opts.shares));
  if (opts.comments !== undefined) zip.addFile('Comments.csv', Buffer.from(opts.comments));
  return zip.toBuffer();
}

type VoiceImportBody = {
  ok: boolean;
  imported: { post: number; comment: number };
  duplicates: { post: number; comment: number };
  skippedNoText: { post: number; comment: number };
  totalRows: { post: number; comment: number };
  noop: boolean;
  message: string;
  profile: Record<'post' | 'comment' | 'reply', { itemCount: number; measurable: boolean }>;
};

type CaughtHttpError = { status: number; message: string };

/** Narrows a caught value to `@sveltejs/kit`'s `error()` throw shape
 * (`{ status, body: { message } }`) via `in`/`typeof` guards only - no
 * inline cast stands between the check and the read. */
function asHttpError(value: unknown): CaughtHttpError {
  if (typeof value !== 'object' || value === null) throw value;
  if (!('status' in value) || typeof value.status !== 'number') throw value;
  if (!('body' in value) || typeof value.body !== 'object' || value.body === null) throw value;
  const body = value.body;
  if (!('message' in body) || typeof body.message !== 'string') throw value;
  return { status: value.status, message: body.message };
}

async function statusOf(promise: Promise<Response>): Promise<number> {
  try {
    return (await promise).status;
  } catch (e) {
    return asHttpError(e).status;
  }
}

async function messageOf(promise: Promise<Response>): Promise<string> {
  try {
    await promise;
    throw new Error('expected a thrown HTTP error');
  } catch (e) {
    return asHttpError(e).message;
  }
}

describe('POST /api/extension/voice-import', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token (401)', async () => {
    const res = voiceImportPost({
      request: rawRequest(null, 'application/zip', buildExportZip({ shares: SHARES_CSV })),
    } as never);
    await expect(res).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an unrecognised Content-Type (400) with a readable message', async () => {
    const org = await seedOrg('vi-bad-content-type');
    await mintDevice(org.id, 'tokCT');

    const res = voiceImportPost({
      request: rawRequest('tokCT', 'application/json', Buffer.from('{}')),
    } as never);
    expect(await statusOf(res)).toBe(400);
  });

  it('refuses an empty body (400)', async () => {
    const org = await seedOrg('vi-empty');
    await mintDevice(org.id, 'tokEmpty');

    const res = voiceImportPost({
      request: rawRequest('tokEmpty', 'application/zip', Buffer.alloc(0)),
    } as never);
    expect(await statusOf(res)).toBe(400);
  });

  it('refuses a body over the size cap (413), checked against Content-Length before parsing', async () => {
    const org = await seedOrg('vi-oversized');
    await mintDevice(org.id, 'tokBig');

    // MAX_VOICE_IMPORT_BYTES is 20MB - one byte over it is enough to prove
    // the cap is enforced without needing a real export that large.
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
    const res = voiceImportPost({
      request: rawRequest('tokBig', 'application/zip', oversized),
    } as never);
    const message = await messageOf(res);
    expect(message).toMatch(/20MB limit/);
  });

  it("refuses a file that is not a valid zip (400) with adm-zip's own readable message", async () => {
    const org = await seedOrg('vi-not-a-zip');
    await mintDevice(org.id, 'tokNotZip');

    const res = voiceImportPost({
      request: rawRequest('tokNotZip', 'application/zip', Buffer.from('this is not a zip file')),
    } as never);
    const message = await messageOf(res);
    expect(message).toMatch(/invalid|unsupported/i);
  });

  it('refuses a zip with neither Shares.csv nor Comments.csv (400)', async () => {
    const org = await seedOrg('vi-no-csv');
    await mintDevice(org.id, 'tokNoCsv');

    const zip = new AdmZip();
    zip.addFile('Profile.csv', Buffer.from('Name\nAda\n'));
    const res = voiceImportPost({
      request: rawRequest('tokNoCsv', 'application/zip', zip.toBuffer()),
    } as never);
    const message = await messageOf(res);
    expect(message).toMatch(/neither a Shares\.csv nor a Comments\.csv/);
  });

  it('imports a synthetic zip archive and reports per-genre counts, dedup, skipped reposts, and MIN_ITEMS_TO_DERIVE status', async () => {
    const org = await seedOrg('vi-import');
    await mintDevice(org.id, 'tokImport');

    const res = await voiceImportPost({
      request: rawRequest(
        'tokImport',
        'application/zip',
        buildExportZip({ shares: SHARES_CSV, comments: COMMENTS_CSV }),
      ),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as VoiceImportBody;

    expect(body.ok).toBe(true);
    // 2 real posts + 1 bare repost = 3 rows; 1 real comment + 1 bare
    // reaction = 2 rows.
    expect(body.totalRows).toEqual({ post: 3, comment: 2 });
    expect(body.skippedNoText).toEqual({ post: 1, comment: 1 });
    expect(body.imported).toEqual({ post: 2, comment: 1 });
    expect(body.duplicates).toEqual({ post: 0, comment: 0 });
    expect(body.noop).toBe(false);

    // MIN_ITEMS_TO_DERIVE is 3: 2 posts alone doesn't clear it, but the
    // pooled corpus's own item count does regardless of genre - only the
    // per-genre `measurable` flags below are genre-gated.
    expect(body.profile.post.itemCount).toBe(2);
    expect(body.profile.post.measurable).toBe(false);
    expect(body.profile.comment.itemCount).toBe(1);
    expect(body.profile.comment.measurable).toBe(false);

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, org.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === 'import')).toBe(true);
  });

  it('re-posting the same archive is an explicit no-op, not a silent success', async () => {
    const org = await seedOrg('vi-repost');
    await mintDevice(org.id, 'tokRepost');
    const archive = buildExportZip({ shares: SHARES_CSV, comments: COMMENTS_CSV });

    const first = await voiceImportPost({
      request: rawRequest('tokRepost', 'application/zip', archive),
    } as never);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as VoiceImportBody;
    expect(firstBody.imported).toEqual({ post: 2, comment: 1 });

    const second = await voiceImportPost({
      request: rawRequest('tokRepost', 'application/zip', archive),
    } as never);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as VoiceImportBody;

    expect(secondBody.ok).toBe(true);
    expect(secondBody.noop).toBe(true);
    expect(secondBody.imported).toEqual({ post: 0, comment: 0 });
    expect(secondBody.duplicates).toEqual({ post: 2, comment: 1 });
    expect(secondBody.message.toLowerCase()).toContain('nothing new');

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, org.id));
    expect(rows).toHaveLength(3);
  });

  it('accepts a bare Shares.csv via Content-Type: text/csv', async () => {
    const org = await seedOrg('vi-bare-csv');
    await mintDevice(org.id, 'tokCsv');

    const res = await voiceImportPost({
      request: rawRequest('tokCsv', 'text/csv', Buffer.from(SHARES_CSV)),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as VoiceImportBody;
    expect(body.imported).toEqual({ post: 2, comment: 0 });
    expect(body.skippedNoText).toEqual({ post: 1, comment: 0 });
  });

  it("scopes an import to the device's own org, so a sibling org sees nothing", async () => {
    const orgA = await seedOrg('vi-org-a');
    const orgB = await seedOrg('vi-org-b');
    await mintDevice(orgA.id, 'tokOrgA');

    const res = await voiceImportPost({
      request: rawRequest('tokOrgA', 'application/zip', buildExportZip({ shares: SHARES_CSV })),
    } as never);
    expect(res.status).toBe(200);

    const orgBRows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgB.id));
    expect(orgBRows).toHaveLength(0);

    const orgARows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, orgA.id));
    expect(orgARows).toHaveLength(2);
  });
});
