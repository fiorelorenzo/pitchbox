import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #548: the assist plane's own plan gate. `POST /api/extension/suggest`
 * refuses with a renderable `200 {refused: 'plan_limit_reached'}` once an
 * org has used its whole `suggestionsPerMonth` allowance for the period -
 * never a 500, since this is the system working, not a defect.
 *
 * In its own module for a fresh in-memory rate-limiter budget, the same
 * reason extension-suggest-usage.test.ts and extension-suggest-retune.test.ts
 * already are (see their own header comments).
 */

const REASONING = 'Noticed the cache change and the specific number.';
const DRAFT = 'A specific thing that happened.';
const ENVELOPE_CHUNKS = [`${REASONING}\n`, DRAFT_MARKER, '\n', DRAFT];

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: () => ({
    slug: 'fake',
    run(opts: { onTextChunk?: (c: string) => void }) {
      for (const c of ENVELOPE_CHUNKS) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({
          exitCode: 0,
          logPath: '/dev/null',
          usage: {
            inputTokens: 2,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.004,
            costReported: true,
          },
        }),
        cancel: () => {},
      };
    },
  }),
}));

// Dynamic on purpose - vi.mock above is hoisted, but the route module has to
// load after it for createAgentRunner to resolve to the fake agent (same
// pattern as every other suggest-route test in this repo).
const { POST: suggest } = await import('../src/routes/api/extension/suggest/+server.js');

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM assist_usage`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
}

async function seedOrgProject(slug: string, plan: string = 'free') {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `p-${slug}`,
      name: slug,
      description: `about ${slug}`,
      defaultAgentRunner: 'cloud',
    })
    .returning();
  await saveLinkedInAssistSettings(db, org.id, {
    ...defaultLinkedInAssistSettings(),
    enabled: true,
    projectId: project.id,
  });
  return { org, project };
}

async function mintDevice(organizationId: number | null, token: string) {
  const [device] = await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' })
    .returning();
  return device;
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

function request(token: string | null, body: unknown) {
  return new Request('http://x/api/extension/suggest', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000099',
    authorName: 'Giulia Bianchi',
    text: 'We cut p99 in half.',
  },
};

describe('POST /api/extension/suggest is plan-limit-gated (#548)', () => {
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

  it('refuses with a renderable 200, not a 500, once the org is at its plan limit', async () => {
    const { org, project } = await seedOrgProject('plan-limit-suggest-over');
    await mintDevice(org.id, 'tok-suggest-over');
    await seedProducedSuggestions(org.id, project.id, freeLimit);

    const res = await suggest({
      request: request('tok-suggest-over', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refused?: string;
      metric?: string;
      limit?: number;
      used?: number;
    };
    expect(body.refused).toBe('plan_limit_reached');
    expect(body.metric).toBe('suggestions');
    expect(body.limit).toBe(freeLimit);
    expect(body.used).toBe(freeLimit);
    // Refused before the model ever ran - no new ledger row from this call.
    const rows = await getDb()
      .select()
      .from(schema.assistUsage)
      .where(eq(schema.assistUsage.projectId, project.id));
    expect(rows).toHaveLength(freeLimit);
  });

  it('an org under its plan limit proceeds and streams a real suggestion', async () => {
    const { org, project } = await seedOrgProject('plan-limit-suggest-under');
    await mintDevice(org.id, 'tok-suggest-under');
    await seedProducedSuggestions(org.id, project.id, freeLimit - 1);

    const res = await suggest({
      request: request('tok-suggest-under', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).not.toContain('plan_limit_reached');
  });

  it('a self-host install refuses nothing, however many suggestions the org has produced', async () => {
    delete process.env.PITCHBOX_EDITION;
    const { org, project } = await seedOrgProject('plan-limit-suggest-self-host');
    await mintDevice(org.id, 'tok-suggest-self-host');
    await seedProducedSuggestions(org.id, project.id, freeLimit + 25);

    const res = await suggest({
      request: request('tok-suggest-self-host', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done');
  });

});
