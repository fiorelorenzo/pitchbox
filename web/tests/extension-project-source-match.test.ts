// Exercises web/src/routes/api/extension/project-source-match: the device
// auth, the org scoping, and the pending-match logic behind linkedin-source-
// capture.ts's two calls (#436, spike #435's "Plane 3"). Modelled on
// extension-operator-profile.test.ts's own seeding/mintDevice harness.
import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { createProjectSource } from '@pitchbox/shared/project-sources';
import { GET, POST } from '../src/routes/api/extension/project-source-match/+server.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE project_sources, projects RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // A plain DELETE, not TRUNCATE ... RESTART IDENTITY: the route's rate
  // limiter is keyed by numeric device id (extension-observations.test.ts's
  // own note on this), so resetting the id sequence would collide two
  // tests' devices in the same in-memory bucket.
  await getDb().execute(sql`DELETE FROM extension_devices`);
}

function getReq(path: string, token: string | null): { request: Request; url: URL } {
  const url = new URL(`http://x${path}`);
  return {
    request: new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    url,
  };
}

function postReq(token: string | null, body: unknown): { request: Request } {
  return {
    request: new Request('http://x/api/extension/project-source-match', {
      method: 'POST',
      headers: token
        ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        : {},
      body: JSON.stringify(body),
    }),
  };
}

async function seedOrg(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  return org;
}

async function seedProject(organizationId: number, slug: string) {
  const [project] = await getDb()
    .insert(schema.projects)
    .values({ organizationId, slug, name: slug })
    .returning();
  return project;
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

function postOutput(overrides: Record<string, unknown> = {}) {
  return {
    urn: 'urn:li:activity:123',
    text: 'What we shipped this week.',
    authorName: 'Jane Doe',
    authorHandle: 'jane-doe',
    ...overrides,
  };
}

describe('GET /api/extension/project-source-match', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token (401)', async () => {
    await expect(
      GET(getReq('/api/extension/project-source-match?kind=linkedin_post&identifier=x', null)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('400s an invalid kind', async () => {
    const org = await seedOrg('psm-get-invalid-kind');
    await mintDevice(org.id, 'tokInvalidKind');
    await expect(
      GET(
        getReq(
          '/api/extension/project-source-match?kind=linkedin_company&identifier=x',
          'tokInvalidKind',
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('400s a missing identifier', async () => {
    const org = await seedOrg('psm-get-missing-id');
    await mintDevice(org.id, 'tokMissingId');
    await expect(
      GET(getReq('/api/extension/project-source-match?kind=linkedin_post', 'tokMissingId')),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns a real pending source as a match', async () => {
    const org = await seedOrg('psm-get-match');
    const project = await seedProject(org.id, 'p');
    await mintDevice(org.id, 'tokMatch');
    const source = await createProjectSource(getDb(), org.id, project.id, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const res = await GET(
      getReq(
        '/api/extension/project-source-match?kind=linkedin_post&identifier=urn%3Ali%3Aactivity%3A123',
        'tokMatch',
      ),
    );
    const body = (await res.json()) as { match: { sourceId: number } | null };
    expect(body.match).toEqual({ sourceId: source!.id });
  });

  it('returns null when nothing pending matches', async () => {
    const org = await seedOrg('psm-get-nomatch');
    await mintDevice(org.id, 'tokNoMatch');

    const res = await GET(
      getReq(
        '/api/extension/project-source-match?kind=linkedin_post&identifier=urn%3Ali%3Aactivity%3A999',
        'tokNoMatch',
      ),
    );
    const body = (await res.json()) as { match: { sourceId: number } | null };
    expect(body.match).toBeNull();
  });

  it("never matches a pending source belonging to another organization's device", async () => {
    const ownerOrg = await seedOrg('psm-get-scope-owner');
    const ownerProject = await seedProject(ownerOrg.id, 'p');
    const otherOrg = await seedOrg('psm-get-scope-other');
    await mintDevice(otherOrg.id, 'tokScope');
    await createProjectSource(getDb(), ownerOrg.id, ownerProject.id, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const res = await GET(
      getReq(
        '/api/extension/project-source-match?kind=linkedin_post&identifier=urn%3Ali%3Aactivity%3A123',
        'tokScope',
      ),
    );
    const body = (await res.json()) as { match: { sourceId: number } | null };
    expect(body.match).toBeNull();
  });
});

describe('POST /api/extension/project-source-match', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token (401)', async () => {
    await expect(
      POST(
        postReq(null, {
          sourceId: 1,
          kind: 'linkedin_post',
          identifier: 'urn:li:activity:123',
          output: postOutput(),
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('400s an invalid body', async () => {
    const org = await seedOrg('psm-post-invalid');
    await mintDevice(org.id, 'tokPostInvalid');
    await expect(
      POST(postReq('tokPostInvalid', { sourceId: 1, kind: 'linkedin_post' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fills a real pending row and clamps free text', async () => {
    const org = await seedOrg('psm-post-fill');
    const project = await seedProject(org.id, 'p');
    await mintDevice(org.id, 'tokFill');
    const source = await createProjectSource(getDb(), org.id, project.id, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const res = await POST(
      postReq('tokFill', {
        sourceId: source!.id,
        kind: 'linkedin_post',
        identifier: 'urn:li:activity:123',
        output: postOutput({ text: `  ${'x'.repeat(3100)}  ` }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; source: { output: { text: string } } };
    expect(body.ok).toBe(true);
    expect(body.source.output.text.length).toBe(3000);
    expect(body.source.output.text).not.toMatch(/^\s|\s$/);

    const [row] = await getDb()
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.id, source!.id));
    expect(row.fetchedAt).not.toBeNull();
    expect((row.output as { urn: string }).urn).toBe('urn:li:activity:123');
  });

  it('answers ok:false rather than throwing when the row is no longer pending', async () => {
    const org = await seedOrg('psm-post-stale');
    const project = await seedProject(org.id, 'p');
    await mintDevice(org.id, 'tokStale');
    const source = await createProjectSource(getDb(), org.id, project.id, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });
    await getDb()
      .update(schema.projectSources)
      .set({
        output: { urn: 'urn:li:activity:123', text: 'already captured' },
        fetchedAt: new Date(),
      })
      .where(eq(schema.projectSources.id, source!.id));

    const res = await POST(
      postReq('tokStale', {
        sourceId: source!.id,
        kind: 'linkedin_post',
        identifier: 'urn:li:activity:123',
        output: postOutput({ text: 'a second, unwanted capture' }),
      }),
    );
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);

    const [row] = await getDb()
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.id, source!.id));
    expect((row.output as { text: string }).text).toBe('already captured');
  });

  it("refuses to fill a source belonging to another organization's device", async () => {
    const ownerOrg = await seedOrg('psm-post-scope-owner');
    const ownerProject = await seedProject(ownerOrg.id, 'p');
    const otherOrg = await seedOrg('psm-post-scope-other');
    await mintDevice(otherOrg.id, 'tokPostScope');
    const source = await createProjectSource(
      getDb(),
      ownerOrg.id,
      ownerProject.id,
      'linkedin_post',
      {
        value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
        identifier: 'urn:li:activity:123',
      },
    );

    const res = await POST(
      postReq('tokPostScope', {
        sourceId: source!.id,
        kind: 'linkedin_post',
        identifier: 'urn:li:activity:123',
        output: postOutput(),
      }),
    );
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);

    const [row] = await getDb()
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.id, source!.id));
    expect(row.output).toBeNull();
  });
});
