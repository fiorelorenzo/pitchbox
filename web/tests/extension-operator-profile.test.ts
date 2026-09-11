import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as operatorProfilePost } from '../src/routes/api/extension/operator-profile/+server.js';

/**
 * POST /api/extension/operator-profile (LI-21, 2026-09-07): the server side
 * of the operator persona capture. Modelled on
 * extension-observations.test.ts's own seeding/mintDevice harness.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE operator_profiles, operator_voice_samples, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // A plain DELETE, not TRUNCATE ... RESTART IDENTITY: the route's rate
  // limiter is keyed by numeric device id (see extension-observations.test.ts's
  // own note on this), so resetting the id sequence would collide two
  // tests' devices in the same in-memory bucket.
  await getDb().execute(sql`DELETE FROM extension_devices`);
}

function bearer(token: string | null, body: unknown): Request {
  return new Request('http://x/api/extension/operator-profile', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
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

async function linkedinPlatformId(): Promise<number> {
  const [p] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  return p!.id;
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    handle: 'ada-lovelace',
    displayName: 'Ada Lovelace',
    headline: 'Mathematician and writer',
    about: 'I write about the analytical engine.',
    experiences: [{ title: 'Founder', company: 'Analytical Engine Co.', period: '2020 - Present' }],
    ...overrides,
  };
}

describe('POST /api/extension/operator-profile', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token (401)', async () => {
    await expect(
      operatorProfilePost({ request: bearer(null, capture()) } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  // #523 retired the personal project and, with it, the LinkedIn account
  // this route used to file under it - the assistant binds to the operator
  // profile and the connected account directly now, never a synthesized
  // "personal" project. Migrated, not re-pinned: the observable contract
  // this test still defends is that a first capture persists the persona,
  // and it now also proves the retired side effect really is gone.
  it('a first capture establishes the persona, with no project or account created', async () => {
    const org = await seedOrg('op-profile-first');
    await mintDevice(org.id, 'tokFirst');

    const res = await operatorProfilePost({ request: bearer('tokFirst', capture()) } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const [row] = await getDb()
      .select()
      .from(schema.operatorProfiles)
      .where(eq(schema.operatorProfiles.organizationId, org.id));
    expect(row.handle).toBe('ada-lovelace');
    expect(row.displayName).toBe('Ada Lovelace');
    expect(row.source).toBe('linkedin_capture');

    const orgProjects = await getDb()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, org.id));
    expect(orgProjects).toHaveLength(0);

    const orgAccounts = await getDb()
      .select()
      .from(schema.accounts)
      .innerJoin(schema.projects, eq(schema.accounts.projectId, schema.projects.id))
      .where(eq(schema.projects.organizationId, org.id));
    expect(orgAccounts).toHaveLength(0);
  });

  it('refuses a capture whose handle differs from the operator already on file, and does not touch the row', async () => {
    const org = await seedOrg('op-profile-guard');
    await mintDevice(org.id, 'tokGuard');

    await operatorProfilePost({ request: bearer('tokGuard', capture()) } as never);

    const res = await operatorProfilePost({
      request: bearer(
        'tokGuard',
        capture({
          handle: 'someone-else',
          displayName: 'Someone Else',
          about: 'A different life entirely.',
        }),
      ),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refused?: string };
    expect(body).toEqual({ ok: false, refused: 'not_your_profile' });

    const [row] = await getDb()
      .select()
      .from(schema.operatorProfiles)
      .where(eq(schema.operatorProfiles.organizationId, org.id));
    expect(row.handle).toBe('ada-lovelace');
    expect(row.displayName).toBe('Ada Lovelace');
  });

  // LOR-180: the client-side capture stored LinkedIn's own Italian
  // notification-count badge ("0 notifiche in totale") as the display
  // name. `readOwnProfile`'s own selector scoping is a defense the server
  // cannot see past, so this is the check that actually stops it.
  it('refuses a first capture whose display name is not name-shaped, and creates no row', async () => {
    const org = await seedOrg('op-profile-implausible-name');
    await mintDevice(org.id, 'tokImplausible');

    const res = await operatorProfilePost({
      request: bearer('tokImplausible', capture({ displayName: '0 notifiche in totale' })),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refused?: string };
    expect(body).toEqual({ ok: false, refused: 'implausible_name' });

    const rows = await getDb()
      .select()
      .from(schema.operatorProfiles)
      .where(eq(schema.operatorProfiles.organizationId, org.id));
    expect(rows).toHaveLength(0);
  });

  it('refuses a re-capture whose display name is not name-shaped, and does not touch the existing row', async () => {
    const org = await seedOrg('op-profile-implausible-recapture');
    await mintDevice(org.id, 'tokImplausibleRecapture');
    await operatorProfilePost({
      request: bearer('tokImplausibleRecapture', capture()),
    } as never);

    const res = await operatorProfilePost({
      request: bearer(
        'tokImplausibleRecapture',
        capture({ displayName: '(3) 0 notifiche in totale' }),
      ),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refused?: string };
    expect(body).toEqual({ ok: false, refused: 'implausible_name' });

    const [row] = await getDb()
      .select()
      .from(schema.operatorProfiles)
      .where(eq(schema.operatorProfiles.organizationId, org.id));
    expect(row.displayName).toBe('Ada Lovelace');
  });

  it('accepts real multi-word, hyphenated and accented names', async () => {
    const org = await seedOrg('op-profile-name-shapes');
    await mintDevice(org.id, 'tokNameShapes');

    for (const name of ['Jean-Luc Picard', 'María José García', 'Ada']) {
      const res = await operatorProfilePost({
        request: bearer('tokNameShapes', capture({ handle: 'ada-lovelace', displayName: name })),
      } as never);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    }
  });

  it('does not clobber a manual row without overwrite: true, and voice samples still dedupe on re-capture', async () => {
    const org = await seedOrg('op-profile-manual');
    await mintDevice(org.id, 'tokManual');
    const linkedinId = await linkedinPlatformId();

    // A human hand-edited the persona in Settings first.
    await getDb().insert(schema.operatorProfiles).values({
      organizationId: org.id,
      handle: 'ada-lovelace',
      displayName: 'Ada, by hand',
      source: 'manual',
    });

    const res = await operatorProfilePost({
      request: bearer(
        'tokManual',
        capture({
          displayName: 'Ada Recaptured',
          posts: [{ externalId: 'urn:li:activity:1', text: 'First post' }],
        }),
      ),
    } as never);
    expect(res.status).toBe(200);

    const [row] = await getDb()
      .select()
      .from(schema.operatorProfiles)
      .where(eq(schema.operatorProfiles.organizationId, org.id));
    expect(row.displayName).toBe('Ada, by hand');
    expect(row.source).toBe('manual');

    // Voice samples are a separate table and still recorded regardless.
    const samplesAfterFirst = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, org.id));
    expect(samplesAfterFirst).toHaveLength(1);

    // Re-capturing the same post does not insert a second row.
    await operatorProfilePost({
      request: bearer(
        'tokManual',
        capture({ posts: [{ externalId: 'urn:li:activity:1', text: 'First post, re-scraped' }] }),
      ),
    } as never);
    const samplesAfterSecond = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, org.id));
    expect(samplesAfterSecond).toHaveLength(1);
    expect(samplesAfterSecond[0].text).toBe('First post');
    expect(samplesAfterSecond[0].platformId).toBe(linkedinId);
  });

  it('applies a capture over a manual row when overwrite: true is set', async () => {
    const org = await seedOrg('op-profile-overwrite');
    await mintDevice(org.id, 'tokOverwrite');
    await getDb().insert(schema.operatorProfiles).values({
      organizationId: org.id,
      handle: 'ada-lovelace',
      displayName: 'Ada, by hand',
      source: 'manual',
    });

    await operatorProfilePost({
      request: bearer('tokOverwrite', capture({ displayName: 'Ada Recaptured', overwrite: true })),
    } as never);

    const [row] = await getDb()
      .select()
      .from(schema.operatorProfiles)
      .where(eq(schema.operatorProfiles.organizationId, org.id));
    expect(row.displayName).toBe('Ada Recaptured');
    expect(row.source).toBe('linkedin_capture');
  });

  it('400s a body with no handle', async () => {
    const org = await seedOrg('op-profile-invalid');
    await mintDevice(org.id, 'tokInvalid');

    await expect(
      operatorProfilePost({
        request: bearer('tokInvalid', { displayName: 'No handle here' }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  // LOR-228: the extension's own /comments capture, alongside the existing
  // posts one.
  it('records a captured comment with genre "comment" and the post it answered as context', async () => {
    const org = await seedOrg('op-profile-comment');
    await mintDevice(org.id, 'tokComment');
    const linkedinId = await linkedinPlatformId();

    const res = await operatorProfilePost({
      request: bearer(
        'tokComment',
        capture({
          comments: [
            {
              externalId: 'urn:li:comment:(activity:1,2)',
              text: 'Great point.',
              context: 'The original post text.',
            },
          ],
        }),
      ),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; voiceSamplesRecorded: number };
    expect(body).toEqual({ ok: true, voiceSamplesRecorded: 1 });

    const [row] = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, org.id));
    expect(row.genre).toBe('comment');
    expect(row.source).toBe('capture');
    expect(row.context).toBe('The original post text.');
    expect(row.text).toBe('Great point.');
    expect(row.platformId).toBe(linkedinId);
  });

  it('records posts and comments from the same capture, each keeping its own genre, and dedupes each on re-capture', async () => {
    const org = await seedOrg('op-profile-mixed-genre');
    await mintDevice(org.id, 'tokMixed');

    const captureBody = capture({
      posts: [{ externalId: 'urn:li:activity:1', text: 'A post.' }],
      comments: [
        { externalId: 'urn:li:comment:(activity:1,2)', text: 'A comment.', context: 'A post.' },
      ],
    });
    await operatorProfilePost({ request: bearer('tokMixed', captureBody) } as never);
    // Re-capturing the identical payload must not grow either row.
    await operatorProfilePost({ request: bearer('tokMixed', captureBody) } as never);

    const rows = await getDb()
      .select()
      .from(schema.operatorVoiceSamples)
      .where(eq(schema.operatorVoiceSamples.organizationId, org.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.text === 'A post.')?.genre).toBe('post');
    expect(rows.find((r) => r.text === 'A comment.')?.genre).toBe('comment');
  });
});
