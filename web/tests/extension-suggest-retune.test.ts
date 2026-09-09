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
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';

/**
 * The retune control (#409): a panel-level regenerate-in-a-direction request
 * that rides the same `POST /api/extension/suggest` route as a first-time
 * suggestion, in a fresh module (and so a fresh in-memory rate-limiter
 * budget) rather than appended to `extension-suggest.test.ts` - that file's
 * own tone-test comment records it is already at 19 of its 20-per-minute
 * per-device budget, and every real HTTP call in this file needs headroom
 * `extension-suggest.test.ts` does not have left (`TRUNCATE ... RESTART
 * IDENTITY` hands every test in a process device id 1, and the per-device
 * limiter is keyed on that id for the whole file's run, not per test).
 *
 * What is worth pinning here, beyond `suggest-prompt.test.ts`'s own
 * "retune (#409)" describe block (which proves the direction changes the
 * prompt in isolation): that the route actually forwards `body.retune` into
 * the prompt the runner receives, that a retune is bound by the exact same
 * daily-quota gate a first request is (no bypass for the new field), and
 * that it refuses the same way a first request does when the org's
 * assistant is off.
 */

const REASONING = 'Noticed the specific number.';
const DRAFT = 'A specific thing that happened.';
const ENVELOPE_CHUNKS = [`${REASONING}\n`, DRAFT_MARKER, '\n', DRAFT];
let responseChunks: string[] = ENVELOPE_CHUNKS;

let lastOptions: AgentRunOptions | null = null;

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      lastOptions = opts;
      for (const c of responseChunks) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({ exitCode: 0, logPath: '/dev/null' }),
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
  lastOptions = null;
  responseChunks = ENVELOPE_CHUNKS;
}

async function seedOrgProject(slug: string, opts: { assist?: boolean } = {}) {
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
  if (opts.assist ?? true) {
    await saveLinkedInAssistSettings(db, org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
    });
  }
  return { org, project, platform };
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
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
    urn: 'urn:li:activity:7000000000000000002',
    authorName: 'Marco Verdi',
    text: 'We migrated the queue and cut p99 latency in half.',
  },
};

describe('retune (#409): a direction on the same POST /api/extension/suggest route', () => {
  beforeEach(reset);

  it('reaches the prompt the runner received', async () => {
    const { org, project } = await seedOrgProject('org-retune-prompt');
    await mintDevice(org.id, 'tokPrompt');

    const res = await suggest({
      request: request('tokPrompt', { ...POST_BODY, projectId: project.id, retune: 'warmer' }),
    } as never);
    await readEvents(res);

    // The direction's own sentence (suggest-prompt.ts's RETUNE_INSTRUCTION),
    // not just the word "warmer" - a prompt could mention the word for other
    // reasons, but only the real instruction proves the field was wired
    // through the schema and into `buildSuggestionPrompt`.
    expect(lastOptions?.prompt).toContain('let real interest show');
    expect(lastOptions?.prompt).toContain('outranks the tone above');
  });

  it('reaches the prompt the same way for every direction, and adds nothing when absent', async () => {
    const { org, project } = await seedOrgProject('org-retune-none');
    await mintDevice(org.id, 'tokNone');

    const res = await suggest({
      request: request('tokNone', { ...POST_BODY, projectId: project.id }),
    } as never);
    await readEvents(res);
    expect(lastOptions?.prompt).not.toContain('outranks the tone above');
  });

  // #409's own acceptance: a retune costs a model call, so it is bound by
  // the exact same cap a first suggestion is - no bypass for the new field.
  // #521/#548 retired the per-account daily quota this used to prove that
  // against (an accepted suggestion no longer creates a draft or an
  // account-scoped send record at all); what actually bounds this route now
  // is the org's own plan ceiling (`suggestionsPerMonth`,
  // extension-suggest-plan-limit.test.ts), so this proves parity against
  // that instead: exhausting it before the retune call refuses the retune
  // exactly like it would a first request.
  it('a retune counts against the caps: refused once the plan\u2019s suggestion ceiling is spent', async () => {
    const savedEdition = process.env.PITCHBOX_EDITION;
    process.env.PITCHBOX_EDITION = 'cloud';
    try {
      const db = getDb();
      const { org, project, platform } = await seedOrgProject('org-retune-cap');
      await mintDevice(org.id, 'tokCap');
      const limit = PLAN_CATALOGUE.free.suggestionsPerMonth!;
      for (let i = 0; i < limit; i += 1) {
        await db.insert(schema.assistUsage).values({
          organizationId: org.id,
          projectId: project.id,
          deviceId: null,
          platformId: platform.id,
          kind: 'post_comment',
          agentRunner: 'claude-code',
        });
      }

      const res = await suggest({
        request: request('tokCap', { ...POST_BODY, projectId: project.id, retune: 'shorter' }),
      } as never);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { refused: string; metric: string };
      expect(body.refused).toBe('plan_limit_reached');
      expect(body.metric).toBe('suggestions');
      expect(lastOptions).toBeNull();
    } finally {
      if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
      else process.env.PITCHBOX_EDITION = savedEdition;
    }
  });

  it('with the assistant switched off, refuses with the same shape a first call gets', async () => {
    const { org, project } = await seedOrgProject('org-retune-off', { assist: false });
    await mintDevice(org.id, 'tokOff');

    const res = await suggest({
      request: request('tokOff', { ...POST_BODY, projectId: project.id, retune: 'drier' }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'assist_disabled' });
    // Refused before the model ever ran - a retune's refusal costs nothing
    // more than a first request's does.
    expect(lastOptions).toBeNull();
  });

  it('names the kill switch distinctly for a retune too, so the panel can say who stopped it', async () => {
    const { org, project } = await seedOrgProject('org-retune-killed', { assist: false });
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      killSwitch: true,
    });
    await mintDevice(org.id, 'tokKilled');

    const res = await suggest({
      request: request('tokKilled', { ...POST_BODY, projectId: project.id, retune: 'warmer' }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'kill_switch' });
    expect(lastOptions).toBeNull();
  });
});
