import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';
import { POST as observationsPost } from '../src/routes/api/extension/observations/+server.js';

/**
 * #548: the observation collector mirrors the suggest route's own plan
 * gate (AGENTS.md's precedent - any new route on the assist plane loads the
 * switch state and refuses). 403, matching this route's existing shape
 * (the collector is not a user-visible action, unlike the renderable 200
 * suggest uses).
 */

async function reset() {
  await getDb().execute(sql`TRUNCATE observed_targets, projects RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM assist_usage`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
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

async function seedOrgWithProject(slug: string, plan: string = 'free') {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  await saveLinkedInAssistSettings(db, org.id, {
    ...defaultLinkedInAssistSettings(),
    enabled: true,
    collectorEnabled: true,
    projectId: project.id,
  });
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

async function seedProducedSuggestions(orgId: number, projectId: number, count: number) {
  const db = getDb();
  const [platform] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  for (let i = 0; i < count; i += 1) {
    await db.insert(schema.assistUsage).values({
      organizationId: orgId,
      projectId,
      deviceId: null,
      platformId: platform.id,
      kind: 'post_comment',
      agentRunner: 'claude-code',
    });
  }
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'urn:li:activity:88881',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:88881/',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    text: 'A post about outreach automation.',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function isHttpError(value: unknown): value is { status: number; body?: { message?: string } } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('status' in value)) return false;
  return typeof value.status === 'number';
}

async function statusAndBodyOf(
  promise: Promise<Response>,
): Promise<{ status: number; message: unknown }> {
  try {
    const res = await promise;
    return { status: res.status, message: await res.json().catch(() => null) };
  } catch (e) {
    if (isHttpError(e)) return { status: e.status, message: e.body?.message };
    throw e;
  }
}

describe('POST /api/extension/observations is plan-limit-gated (#548)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  const freeLimit = PLAN_CATALOGUE.free.suggestionsPerMonth!;

  it('refuses with a 403 once the org is at its suggestions plan limit', async () => {
    const { org, project } = await seedOrgWithProject('obs-plan-limit-over');
    await mintDevice(org.id, 'tok-obs-over');
    await seedProducedSuggestions(org.id, project.id, freeLimit);

    const { status, message } = await statusAndBodyOf(
      observationsPost({
        request: bearer('tok-obs-over', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as unknown as Parameters<typeof observationsPost>[0]),
    );

    expect(status).toBe(403);
    expect(message).toBe('plan_limit_reached');
  });

  it('an org under its plan limit is admitted', async () => {
    const { org, project } = await seedOrgWithProject('obs-plan-limit-under');
    await mintDevice(org.id, 'tok-obs-under');
    await seedProducedSuggestions(org.id, project.id, freeLimit - 1);

    const { status } = await statusAndBodyOf(
      observationsPost({
        request: bearer('tok-obs-under', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as unknown as Parameters<typeof observationsPost>[0]),
    );

    expect(status).toBe(200);
  });

  it('a self-host install refuses nothing, however many suggestions the org has produced', async () => {
    delete process.env.PITCHBOX_EDITION;
    const { org, project } = await seedOrgWithProject('obs-plan-limit-self-host');
    await mintDevice(org.id, 'tok-obs-self-host');
    await seedProducedSuggestions(org.id, project.id, freeLimit + 25);

    const { status } = await statusAndBodyOf(
      observationsPost({
        request: bearer('tok-obs-self-host', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as unknown as Parameters<typeof observationsPost>[0]),
    );

    expect(status).toBe(200);
  });
});
