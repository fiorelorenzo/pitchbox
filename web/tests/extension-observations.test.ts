import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { POST as observationsPost } from '../src/routes/api/extension/observations/+server.js';

/**
 * POST /api/extension/observations (#301), the server side of the LinkedIn
 * observation buffer. Modelled on extension-draft-org-scope.test.ts's
 * seeding/mintDevice harness, plus the batch-ingest and rate-limit
 * behaviours specific to this route.
 */

async function reset() {
  await getDb().execute(sql`TRUNCATE observed_targets, projects RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // Deliberately a plain DELETE, not TRUNCATE ... RESTART IDENTITY: the
  // route's rate limiter is keyed by numeric device id, and resetting the id
  // sequence every test would give several tests' devices the same id,
  // colliding in the same in-memory bucket for the limiter's 60s window. A
  // monotonically increasing id keeps every test's device in its own bucket.
  await getDb().execute(sql`DELETE FROM extension_devices`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
}

function bearer(token: string | null, body: unknown): Request {
  return new Request('http://x/api/extension/observations', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

/**
 * Seeds an org and a project, and by default binds the LinkedIn assistant to
 * that project with the collector on. That binding is a precondition of the
 * route now, not decoration: the collector is off by default (#316), and the
 * route refuses a post an admin never switched on. Pass `assist: false` to
 * seed the default off state.
 */
async function seedOrgWithProject(slug: string, opts: { assist?: boolean } = {}) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  if (opts.assist ?? true) {
    await saveLinkedInAssistSettings(db, org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      collectorEnabled: true,
      projectId: project.id,
    });
  }
  return { org, project };
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

function observation(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'urn:li:activity:9999',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:9999/',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    text: 'A post about outreach automation.',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Narrows a caught value to the shape @sveltejs/kit's `error()` throws. */
function isHttpError(value: unknown): value is { status: number } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('status' in value)) return false;
  return typeof value.status === 'number';
}

async function statusOf(promise: Promise<Response>): Promise<number> {
  try {
    return (await promise).status;
  } catch (e) {
    if (isHttpError(e)) return e.status;
    throw e;
  }
}

describe('POST /api/extension/observations', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token (401)', async () => {
    await expect(
      observationsPost({
        request: bearer(null, { platform: 'linkedin', projectId: 1, items: [] }),
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a revoked device token (401)', async () => {
    const { project } = await seedOrgWithProject('obs-revoked');
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        organizationId: null,
        tokenHash: createHash('sha256').update('tokRevoked').digest('hex'),
        label: 'test-revoked',
        revokedAt: new Date(),
      });

    await expect(
      observationsPost({
        request: bearer('tokRevoked', {
          platform: 'linkedin',
          projectId: project.id,
          items: [],
        }),
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('404s a projectId that does not belong to the device org, so it leaks no other tenant ids', async () => {
    const { project: bProject } = await seedOrgWithProject('obs-org-b');
    const { org: orgA } = await seedOrgWithProject('obs-org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      observationsPost({
        request: bearer('tokA', {
          platform: 'linkedin',
          projectId: bProject.id,
          items: [observation()],
        }),
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    const rows = await getDb()
      .select()
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.projectId, bProject.id));
    expect(rows).toHaveLength(0);
  });

  it('a duplicate externalId counts as a duplicate, not a second insert', async () => {
    const { org, project } = await seedOrgWithProject('obs-dup');
    await mintDevice(org.id, 'tokDup');

    const firstRes = await observationsPost({
      request: bearer('tokDup', {
        platform: 'linkedin',
        projectId: project.id,
        items: [observation()],
      }),
    } as never);
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as {
      ok: boolean;
      inserted: number;
      duplicates: number;
      dropped: number;
    };
    expect(first).toMatchObject({ ok: true, inserted: 1, duplicates: 0, dropped: 0 });

    const secondRes = await observationsPost({
      request: bearer('tokDup', {
        platform: 'linkedin',
        projectId: project.id,
        items: [observation()],
      }),
    } as never);
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as {
      ok: boolean;
      inserted: number;
      duplicates: number;
      dropped: number;
    };
    expect(second).toMatchObject({ ok: true, inserted: 0, duplicates: 1, dropped: 0 });

    const rows = await getDb()
      .select()
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.projectId, project.id));
    expect(rows).toHaveLength(1);
  });

  it('drops a malformed item while its siblings still insert', async () => {
    const { org, project } = await seedOrgWithProject('obs-malformed');
    await mintDevice(org.id, 'tokMal');

    const res = await observationsPost({
      request: bearer('tokMal', {
        platform: 'linkedin',
        projectId: project.id,
        items: [
          observation({ externalId: 'urn:li:activity:1' }),
          // Malformed: no externalId, not a URL, unparsable date.
          { url: 'not-a-url', observedAt: 'not-a-date' },
          observation({ externalId: 'urn:li:activity:2' }),
        ],
      }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      inserted: number;
      duplicates: number;
      dropped: number;
    };
    expect(body).toMatchObject({ ok: true, inserted: 2, duplicates: 0, dropped: 1 });

    const rows = await getDb()
      .select()
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.projectId, project.id));
    expect(rows).toHaveLength(2);
  });

  it('rate limits a device that sends too many batches', async () => {
    const { org, project } = await seedOrgWithProject('obs-ratelimit');
    await mintDevice(org.id, 'tokRate');

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        await statusOf(
          observationsPost({
            request: bearer('tokRate', {
              platform: 'linkedin',
              projectId: project.id,
              items: [observation({ externalId: `urn:li:activity:rate-${i}` })],
            }),
          } as never),
        ),
      );
    }

    const passedThrough = statuses.filter((s) => s === 200).length;
    const throttled = statuses.filter((s) => s === 429).length;
    expect(passedThrough).toBe(30);
    expect(throttled).toBe(1);
    expect(passedThrough + throttled).toBe(statuses.length);
  });

  // #316 shipped the collector switch, the kill switch and the device read
  // path, but nothing on the server refused a post that ignored them. These
  // three fail on the code as #357 left it: measured before the gate landed,
  // every one of them returned 200 and wrote the row.
  it('refuses a collector that an admin never switched on, which is the default state', async () => {
    const { org, project } = await seedOrgWithProject('obs-collector-off', { assist: false });
    await mintDevice(org.id, 'tokOff');

    await expect(
      observationsPost({
        request: bearer('tokOff', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    const rows = await getDb()
      .select()
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.projectId, project.id));
    expect(rows).toEqual([]);
  });

  it('refuses while the kill switch is engaged, even with the collector flag left on', async () => {
    const { org, project } = await seedOrgWithProject('obs-killed', { assist: false });
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      collectorEnabled: true,
      projectId: project.id,
      killSwitch: true,
    });
    await mintDevice(org.id, 'tokKilled');

    await expect(
      observationsPost({
        request: bearer('tokKilled', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a project of the same org that is not the bound one', async () => {
    const { org, project } = await seedOrgWithProject('obs-other-project');
    const [other] = await getDb()
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p-obs-other', name: 'other' })
      .returning();
    await mintDevice(org.id, 'tokOther');

    await expect(
      observationsPost({
        request: bearer('tokOther', {
          platform: 'linkedin',
          projectId: other.id,
          items: [observation()],
        }),
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    // The bound project still works from the same device, so this is the
    // binding being enforced and not the device being broken.
    const res = await observationsPost({
      request: bearer('tokOther', {
        platform: 'linkedin',
        projectId: project.id,
        items: [observation()],
      }),
    } as never);
    expect(res.status).toBe(200);
  });
});
