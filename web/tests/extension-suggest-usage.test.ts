import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { DRAFT_MARKER, PROJECT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #522: `POST /api/extension/suggest` writes no `runs` row and, before this
 * table, a suggestion's cost reached the database only if a human accepted
 * it - a panel that streamed twenty suggestions of which two were used had
 * nineteen invisible ones as far as the ledger was concerned. This file
 * pins the fix: `assist_usage` gets one row per finished suggestion,
 * attributed to the org/device/project, the moment the stream ends -
 * whether or not anyone ever accepts it.
 *
 * In its own module (and so a fresh in-memory rate-limiter budget) for the
 * same reason extension-suggest-retune.test.ts is: extension-suggest.test.ts's
 * own comment records it is already at 19 of its 20-per-minute per-device
 * budget, and `TRUNCATE ... RESTART IDENTITY` hands every test in a file
 * device id 1, so the limiter (keyed on that id for the whole file's run)
 * would refuse most of the calls this file needs.
 */

const REASONING = 'Noticed the cache change and the specific number.';
const DRAFT = 'A specific thing that happened.';
const ENVELOPE_CHUNKS = [`${REASONING}\n`, DRAFT_MARKER, '\n', DRAFT];
/**
 * The same answer, with the model stating which project it wrote for. Since
 * LOR-181 the project on a ledger row is the one the **server resolved** from
 * that claim, not one the client sent, so a test that wants a project on the
 * row has to make the model claim it. Without the marker the resolution falls
 * through to personal and the row's `project_id` is null, which is a real
 * outcome (#523 made the column nullable) and is what the last case here
 * asserts.
 */
const envelopeClaiming = (projectId: number) => [
  PROJECT_MARKER,
  '\n',
  `${projectId}\n`,
  ...ENVELOPE_CHUNKS,
];
let responseChunks: string[] = ENVELOPE_CHUNKS;
/** Set by a test to make the fake agent report no usage at all - the panel
 * still gets its answer, but there is nothing to ledger a cost from. */
let usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  costReported: boolean;
} | null = {
  inputTokens: 2,
  outputTokens: 40,
  cacheReadTokens: 780,
  cacheCreationTokens: 0,
  costUsd: 0.004,
  costReported: true,
};

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      for (const c of responseChunks) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({
          exitCode: 0,
          logPath: '/dev/null',
          usage: usage ?? undefined,
        }),
        cancel: () => {},
      };
    },
  }),
}));

// Dynamic, matching every other route test in this repo: `vi.mock` above is
// hoisted, but the mocked module graph must not resolve until after that
// registration runs, and a static import of a route module this early would
// race it.
const { POST: suggest } = await import('../src/routes/api/extension/suggest/+server.js');

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
  // The model assertion below reads `ASSIST_DEFAULT_MODEL`, which only applies
  // when no operator pinned a model for the runner. `runner_configs` is
  // instance-wide and survives every truncate above, so a settings test (or a
  // hand poke at a shared local database) that pinned one made this suite fail
  // with the pinned id while CI, on a fresh database, passed. Measured on the
  // devbox 2026-09-10: a leftover `claude-code.model = claude-sonnet-4-6`.
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'runner_configs'`);
  responseChunks = ENVELOPE_CHUNKS;
  usage = {
    inputTokens: 2,
    outputTokens: 40,
    cacheReadTokens: 780,
    cacheCreationTokens: 0,
    costUsd: 0.004,
    costReported: true,
  };
}

async function seedOrgProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug, description: `about ${slug}` })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  await saveLinkedInAssistSettings(db, org.id, {
    ...defaultLinkedInAssistSettings(),
    enabled: true,
    projectId: project.id,
  });
  return { org, project, platform };
}

async function mintDevice(organizationId: number | null, token: string) {
  const [device] = await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' })
    .returning();
  return device;
}

function request(token: string | null, body: unknown) {
  return new Request('http://x/api/extension/suggest', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

async function readEvents(res: Response): Promise<Array<{ kind: string; data: unknown }>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => {
      const kind = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return kind && data ? { kind, data: JSON.parse(data) } : null;
    })
    .filter((e): e is { kind: string; data: unknown } => e !== null);
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000003',
    authorName: 'Giulia Bianchi',
    text: 'We cut p99 in half.',
  },
};

describe('assist_usage ledger (#522)', () => {
  beforeEach(reset);

  it('ledgers the suggestion the moment the stream finishes, even though nobody accepted it', async () => {
    const { org, project, platform } = await seedOrgProject('org-ledger');
    const device = await mintDevice(org.id, 'tok-ledger');

    responseChunks = envelopeClaiming(project.id);

    const res = await suggest({
      request: request('tok-ledger', POST_BODY),
    } as never);
    await readEvents(res);

    const rows = await getDb().select().from(schema.assistUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: org.id,
      projectId: project.id,
      deviceId: device.id,
      platformId: platform.id,
      kind: 'post_comment',
      agentRunner: project.defaultAgentRunner,
      inputTokens: 2,
      outputTokens: 40,
      cacheReadTokens: 780,
      cacheCreationTokens: 0,
    });
    expect(Number(rows[0].costUsd)).toBeCloseTo(0.004, 4);
    // No draft, no run - a suggestion stays ephemeral until accepted; the
    // ledger is the only trace it ever happened.
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
  });

  it('ledgers every suggestion separately - repeated suggestions leave one row each, not one aggregate', async () => {
    const { org, project } = await seedOrgProject('org-ledger-many');
    await mintDevice(org.id, 'tok-ledger-many');

    responseChunks = envelopeClaiming(project.id);
    for (let i = 0; i < 4; i += 1) {
      const res = await suggest({
        request: request('tok-ledger-many', POST_BODY),
      } as never);
      await readEvents(res);
    }

    const rows = await getDb()
      .select()
      .from(schema.assistUsage)
      .where(eq(schema.assistUsage.projectId, project.id));
    expect(rows).toHaveLength(4);
    // Every row priced independently, not split across an aggregate.
    for (const row of rows) {
      expect(Number(row.costUsd)).toBeCloseTo(0.004, 4);
    }
  });

  it('records the model the suggestion actually resolved to', async () => {
    const { org, project } = await seedOrgProject('org-ledger-model');
    await mintDevice(org.id, 'tok-ledger-model');

    responseChunks = envelopeClaiming(project.id);
    const res = await suggest({
      request: request('tok-ledger-model', POST_BODY),
    } as never);
    await readEvents(res);

    const [row] = await getDb()
      .select()
      .from(schema.assistUsage)
      .where(eq(schema.assistUsage.projectId, project.id));
    // ASSIST_DEFAULT_MODEL: no operator pinned a model for this project's
    // (unpinned) runner, so the suggestion asked for the fast default.
    expect(row.model).toBe('sonnet');
  });

  it('still ledgers a row, with null cost, when the runner reports no usage at all', async () => {
    const { org, project } = await seedOrgProject('org-ledger-nousage');
    await mintDevice(org.id, 'tok-ledger-nousage');
    usage = null;

    responseChunks = envelopeClaiming(project.id);
    const res = await suggest({
      request: request('tok-ledger-nousage', POST_BODY),
    } as never);
    await readEvents(res);

    const rows = await getDb()
      .select()
      .from(schema.assistUsage)
      .where(eq(schema.assistUsage.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBeNull();
    expect(rows[0].inputTokens).toBeNull();
  });

  it('never ledgers a refused suggestion - the kill switch cuts it off before the model ever runs', async () => {
    const db = getDb();
    const slug = 'org-ledger-killswitch';
    const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
      .returning();
    // No saveLinkedInAssistSettings call - the assistant stays off by
    // default, refusing before runSuggestion is ever invoked.
    await mintDevice(org.id, 'tok-ledger-killswitch');

    const res = await suggest({
      request: request('tok-ledger-killswitch', { ...POST_BODY, projectId: project.id }),
    } as never);
    const body = (await res.json()) as { refused?: string };
    expect(body.refused).toBeTruthy();

    expect(await getDb().select().from(schema.assistUsage)).toHaveLength(0);
  });
});
