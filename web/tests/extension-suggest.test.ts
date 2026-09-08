import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import { saveRunnerConfig, type RunnerConfig } from '@pitchbox/shared/agents/config';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
  loadLinkedInAssistDeviceState,
} from '@pitchbox/shared/linkedin-assist';
import { ingestObservedTargets } from '@pitchbox/shared/observed-targets';
import { DRAFT_MARKER, SKIP_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * The real-time suggestion endpoint (#312). What these tests defend is the
 * enforcement boundary and the stream's contract, because the panel is not the
 * boundary: auth, cross-tenant scoping, an exhausted quota, incremental
 * delivery, the reasoning/draft split (#382) and a disconnect actually
 * cancelling the model call rather than leaving it running for nobody.
 *
 * The agent itself is the one thing faked. Everything below it is real: the
 * route, the quota read, the prompt composition and the SSE framing.
 */

const REASONING = 'Noticed the cache change and the specific number.';
const DRAFT = 'A specific thing that happened.';
/** The default fake response: a well-formed envelope, split across several
 * streamed chunks the way a real model call arrives - reasoning first, the
 * marker, then the draft in pieces. */
const ENVELOPE_CHUNKS = [
  `${REASONING}\n`,
  DRAFT_MARKER,
  '\n',
  'A specific ',
  'thing that ',
  'happened.',
];
let responseChunks: string[] = ENVELOPE_CHUNKS;

let lastOptions: AgentRunOptions | null = null;
/** The runner config the route actually handed to the registry, so a test can
 * assert which model a suggestion asks for rather than trusting the resolver
 * in isolation. */
let lastConfig: RunnerConfig | null = null;
let cancelCalls = 0;
/** Set by a test to hold the fake agent open so a disconnect can be observed. */
let hangForever = false;

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, config: RunnerConfig): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      lastOptions = opts;
      lastConfig = config;
      let stop: (() => void) | null = null;
      const result = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new Error('cancelled'));
      }).catch((e: unknown) => {
        throw e;
      }) as unknown as Promise<{ exitCode: number; logPath: string }>;

      if (hangForever) {
        return {
          result,
          cancel: () => {
            cancelCalls += 1;
            stop?.();
          },
        };
      }
      for (const c of responseChunks) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({
          exitCode: 0,
          logPath: '/dev/null',
          usage: {
            // Modelled on the real measurement in #313's comment: the prompt
            // is served from the provider's cache, so almost none of it shows
            // up as `inputTokens` and the rest arrives as the two cache
            // counts instead.
            inputTokens: 2,
            outputTokens: 40,
            cacheReadTokens: 780,
            cacheCreationTokens: 0,
            costUsd: 0.004,
            costReported: true,
          },
        }),
        cancel: () => {
          cancelCalls += 1;
        },
      };
    },
  }),
}));

const { POST: suggest } = await import('../src/routes/api/extension/suggest/+server.js');
const { runSuggestion, resolveAssistRunnerConfig, ASSIST_DEFAULT_MODEL } =
  await import('../src/lib/server/suggest.js');

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'runner_configs'`);
  lastOptions = null;
  lastConfig = null;
  cancelCalls = 0;
  hangForever = false;
  responseChunks = ENVELOPE_CHUNKS;
}

/**
 * Seeds an org and a project, and by default binds the LinkedIn assistant to
 * that project. The binding is a precondition of the route now: the assistant
 * is off until an admin turns it on (#316), and the route refuses rather than
 * trusting the panel to have read the switch. Pass `assist: false` for the
 * default off state.
 */
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

/** Reads an SSE body into its parsed events, in order. */
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
    urn: 'urn:li:activity:7000000000000000001',
    authorName: 'Giulia Bianchi',
    text: 'We cut p99 in half.',
  },
};

describe('POST /api/extension/suggest', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token', async () => {
    await expect(
      suggest({ request: request(null, { ...POST_BODY, projectId: 1 }) } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('404s a project outside the device org, so it leaks no other tenant ids', async () => {
    const { project: bProject } = await seedOrgProject('org-b');
    const { org: orgA } = await seedOrgProject('org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      suggest({ request: request('tokA', { ...POST_BODY, projectId: bProject.id }) } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('streams the suggestion in chunks and closes with a terminal event', async () => {
    const { org, project } = await seedOrgProject('org-a');
    await mintDevice(org.id, 'tok');

    const res = await suggest({
      request: request('tok', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await readEvents(res);
    const kinds = events.map((e) => e.kind);
    // Incremental: at least one chunk event per non-empty piece of the
    // response, not one event carrying the whole answer.
    expect(kinds.filter((k) => k === 'chunk').length).toBeGreaterThan(1);
    expect(kinds).toContain('status');
    expect(kinds[kinds.length - 1]).toBe('done');

    const done = events.at(-1)!.data as {
      reasoning: string;
      draft: string | null;
      skipped: boolean;
      usage?: { outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
    };
    expect(done.reasoning).toBe(REASONING);
    expect(done.draft).toBe(DRAFT);
    expect(done.skipped).toBe(false);
    expect(done.usage?.outputTokens).toBe(40);
    // #313 comment: `inputTokens` alone reads as ~2 tokens for a cached
    // prompt, so the cache counts have to reach the caller for the accept
    // path's `runs` row to not read as broken accounting.
    expect(done.usage?.cacheReadTokens).toBe(780);
    expect(done.usage?.cacheCreationTokens).toBe(0);
  });

  // #382: the fail-safe this endpoint exists for. Every `chunk` event carries
  // the section it belongs to, and the panel is told `status: writing` only
  // once actual draft text starts - never for reasoning, which must never
  // read as something the human could insert.
  it('tags each chunk with its section and flips to writing only when the draft begins', async () => {
    const { org, project } = await seedOrgProject('org-section');
    await mintDevice(org.id, 'tok-section');

    const res = await suggest({
      request: request('tok-section', { ...POST_BODY, projectId: project.id }),
    } as never);
    const events = await readEvents(res);

    const chunkEvents = events.filter((e) => e.kind === 'chunk') as Array<{
      kind: string;
      data: { text: string; section: 'reasoning' | 'draft' };
    }>;
    expect(
      chunkEvents.every((e) => e.data.section === 'reasoning' || e.data.section === 'draft'),
    ).toBe(true);
    const reasoningText = chunkEvents
      .filter((e) => e.data.section === 'reasoning')
      .map((e) => e.data.text)
      .join('');
    const draftText = chunkEvents
      .filter((e) => e.data.section === 'draft')
      .map((e) => e.data.text)
      .join('');
    // Streamed pieces are raw (only `finish()` trims), so the joined
    // reasoning can carry the newline that preceded the marker. And the
    // draft's own trailing ~18 characters (the longest marker's length) are
    // held back by the splitter until `finish()`, in case they are half of a
    // stray marker - see EnvelopeSplitter. The full draft is asserted
    // against `done.draft` in the streaming test above.
    expect(reasoningText.trim()).toBe(REASONING);
    expect(draftText.length).toBeGreaterThan(0);
    expect(DRAFT.startsWith(draftText.trimStart())).toBe(true);

    // Every reasoning chunk precedes every draft chunk: the marker is what
    // separates the two, and nothing draft-flavoured leaks earlier.
    const lastReasoningIdx = chunkEvents.map((e) => e.data.section).lastIndexOf('reasoning');
    const firstDraftIdx = chunkEvents.map((e) => e.data.section).indexOf('draft');
    expect(lastReasoningIdx).toBeLessThan(firstDraftIdx);

    // "writing" appears exactly once, and only after the draft chunks start
    // arriving - "reading" is the only status during the reasoning stretch.
    const statusEvents = events.filter((e) => e.kind === 'status') as Array<{
      data: { phase: string };
    }>;
    const statusPhases = statusEvents.map((e) => e.data.phase);
    expect(statusPhases).toEqual(['reading', 'writing']);
  });

  // The fail-safe itself: a model that never emits the marker (ignored the
  // instruction, or was never asked - see the "prove it bites" note below)
  // must never hand the panel something to insert.
  it('arrives as done with draft: null when the model never emits the marker', async () => {
    const { org, project } = await seedOrgProject('org-unstructured');
    await mintDevice(org.id, 'tok-unstructured');
    responseChunks = ['Just some prose with no marker at all.'];

    const res = await suggest({
      request: request('tok-unstructured', { ...POST_BODY, projectId: project.id }),
    } as never);
    const events = await readEvents(res);

    // No draft chunk ever went out, and status never left "reading".
    const unstructuredChunks = events.filter((e) => e.kind === 'chunk') as Array<{
      data: { section: string };
    }>;
    const chunkSections = unstructuredChunks.map((e) => e.data.section);
    expect(chunkSections).not.toContain('draft');
    const unstructuredStatuses = events.filter((e) => e.kind === 'status') as Array<{
      data: { phase: string };
    }>;
    const statusPhases = unstructuredStatuses.map((e) => e.data.phase);
    expect(statusPhases).toEqual(['reading']);

    const done = events.at(-1)!.data as {
      reasoning: string;
      draft: string | null;
      skipped: boolean;
    };
    expect(done.draft).toBeNull();
    expect(done.skipped).toBe(false);
    expect(done.reasoning).toBe('Just some prose with no marker at all.');
  });

  // A model that explicitly declines: SKIP_MARKER, not silence. Also arrives
  // with draft: null, distinguished only by `skipped`.
  it('arrives as done with draft: null and skipped: true when the model declines', async () => {
    const { org, project } = await seedOrgProject('org-skipped');
    await mintDevice(org.id, 'tok-skipped');
    responseChunks = ['Nothing worth adding here.\n', SKIP_MARKER, '\nExplained above.'];

    const res = await suggest({
      request: request('tok-skipped', { ...POST_BODY, projectId: project.id }),
    } as never);
    const events = await readEvents(res);
    const done = events.at(-1)!.data as {
      reasoning: string;
      draft: string | null;
      skipped: boolean;
    };
    expect(done.draft).toBeNull();
    expect(done.skipped).toBe(true);
  });

  it('attaches no MCP server and passes a prompt rather than a playbook', async () => {
    const { org, project } = await seedOrgProject('org-a');
    await mintDevice(org.id, 'tok');
    await readEvents(
      await suggest({ request: request('tok', { ...POST_BODY, projectId: project.id }) } as never),
    );

    expect(lastOptions?.attachMcp).toBe(false);
    expect(lastOptions?.playbookPath).toBeUndefined();
    expect(lastOptions?.prompt).toContain('We cut p99 in half.');
    // The house style is not optional on this path: a suggestion is text that
    // goes out under a real name.
    expect(lastOptions?.prompt).toContain('House style: write like a human');
    // The envelope instruction is what makes the split possible at all.
    expect(lastOptions?.prompt).toContain(DRAFT_MARKER);
  });

  it('writes no runs row and no draft', async () => {
    const { org, project } = await seedOrgProject('org-a');
    await mintDevice(org.id, 'tok');
    await readEvents(
      await suggest({ request: request('tok', { ...POST_BODY, projectId: project.id }) } as never),
    );

    const runs = await getDb().select().from(schema.runs);
    const drafts = await getDb().select().from(schema.drafts);
    expect(runs).toHaveLength(0);
    expect(drafts).toHaveLength(0);
  });

  it('refuses with a renderable body, not a 500, when the daily quota is spent', async () => {
    const db = getDb();
    const { org, project, platform } = await seedOrgProject('org-a');
    await mintDevice(org.id, 'tok');
    // A LinkedIn account whose own daily limit is already zero: the binding
    // limit is the smaller of platform and account, so this exhausts it
    // without depending on the platform defaults.
    await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'lorenzo',
        dailyLimit: 0,
        active: true,
      })
      .returning();

    const res = await suggest({
      request: request('tok', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { refused: string; window: string };
    expect(body.refused).toBe('quota_exhausted');
    expect(body.window).toBe('day');
    // And it never reached the agent.
    expect(lastOptions).toBeNull();
  });

  // A disconnect has two windows, and the first one is the one that bites:
  // resolving the runner config and making a temp directory are awaits, so a
  // human who closes the panel immediately cancels something that does not
  // exist yet. The invariant both tests defend is the same one, stated as an
  // effect rather than a call count: no model call is left running for nobody.
  it('never starts the agent when cancelled before it spawns', async () => {
    const { project } = await seedOrgProject('org-a');
    hangForever = true;

    // Driven through the service rather than the route, because this window is
    // only observable by awaiting the rejection: by the time the route's stream
    // is cancelled the response is already closed, so an assertion made right
    // after the cancel would run before the spawn could have happened and pass
    // whether or not the gate exists.
    const handle = runSuggestion({
      kind: 'post_comment',
      post: POST_BODY.post,
      currentProject: { name: project.name, description: project.description },
      persona: null,
      projects: [],
      repos: [],
      projectId: project.id,
      runnerSlug: project.defaultAgentRunner,
    });
    handle.cancel();

    await expect(handle.result).rejects.toThrow('cancelled');
    expect(lastOptions).toBeNull();
    expect(cancelCalls).toBe(0);
  });

  it('cancels a running agent when the client disconnects after it spawned', async () => {
    const { org, project } = await seedOrgProject('org-a');
    await mintDevice(org.id, 'tok');
    hangForever = true;

    const res = await suggest({
      request: request('tok', { ...POST_BODY, projectId: project.id }),
    } as never);
    const reader = res.body!.getReader();
    await reader.read(); // the padding
    // Wait for the spawn itself, so this test is about the window it names.
    await vi.waitFor(() => expect(lastOptions).not.toBeNull());
    await reader.cancel();

    await vi.waitFor(() => expect(cancelCalls).toBeGreaterThan(0));
  });

  // The switch #316 shipped was only ever read by a client that chose to read
  // it. All three of these returned a full streamed suggestion on the code as
  // #357 left it, with the org's assistant off.
  it('refuses to suggest for an org that never turned the assistant on', async () => {
    const { org, project } = await seedOrgProject('org-off', { assist: false });
    await mintDevice(org.id, 'tokOff');

    const res = await suggest({
      request: request('tokOff', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'assist_disabled' });
    // No model call at all, which is the point: a refusal that still spawns an
    // agent has only moved the cost.
    expect(lastOptions).toBeNull();
  });

  it('names the kill switch distinctly, so the panel can say who stopped it', async () => {
    const { org, project } = await seedOrgProject('org-killed', { assist: false });
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      killSwitch: true,
    });
    await mintDevice(org.id, 'tokKilled');

    const res = await suggest({
      request: request('tokKilled', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'kill_switch' });
    expect(lastOptions).toBeNull();
  });

  it('refuses to write as a project of the same org that is not the bound one', async () => {
    const { org, project } = await seedOrgProject('org-bound');
    const [other] = await getDb()
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p-other', name: 'other', description: 'other' })
      .returning();
    await mintDevice(org.id, 'tokBound');

    const res = await suggest({
      request: request('tokBound', { ...POST_BODY, projectId: other.id }),
    } as never);
    expect(await res.json()).toMatchObject({
      refused: 'project_not_bound',
      boundProjectId: project.id,
    });
    expect(lastOptions).toBeNull();

    // The bound project still streams from the same device.
    const ok = await suggest({
      request: request('tokBound', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(ok.headers.get('content-type')).toContain('text/event-stream');
    await ok.text();
  });

  // Decision 2026-09-07: the org's own `personal` project is always a valid
  // destination, unlike an arbitrary sibling project of the same org, which
  // the previous test proves still gets refused.
  it('serves a request naming the org personal project even though it is not the bound one', async () => {
    const { org, project } = await seedOrgProject('org-personal');
    await mintDevice(org.id, 'tokPersonal');
    const assist = await loadLinkedInAssistDeviceState(getDb(), org.id);
    expect(assist.personalProjectId).not.toBe(project.id);

    const res = await suggest({
      request: request('tokPersonal', { ...POST_BODY, projectId: assist.personalProjectId }),
    } as never);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.text();
    expect(lastOptions).not.toBeNull();
  });

  // #360: the wait a human sees is dominated by how long the model deliberates
  // before its first text token, so this path asks for a fast model unless an
  // operator pinned one. Asserted against the config the route actually handed
  // the registry, not against the resolver in isolation: the resolver being
  // correct and never called is the failure mode worth catching.
  it('asks for the fast assist model when no operator pinned one', async () => {
    const { org, project } = await seedOrgProject('org-model-default');
    await mintDevice(org.id, 'tokModel');

    const res = await suggest({
      request: request('tokModel', { ...POST_BODY, projectId: project.id }),
    } as never);
    await res.text();
    expect(lastConfig).toMatchObject({ model: ASSIST_DEFAULT_MODEL });
  });

  it('leaves an operator-pinned model alone, including for suggestions', async () => {
    const { org, project } = await seedOrgProject('org-model-pinned');
    await mintDevice(org.id, 'tokPinned');
    await saveRunnerConfig(getDb(), 'claude-code', { model: 'opus', maxTurns: 3 });

    const res = await suggest({
      request: request('tokPinned', { ...POST_BODY, projectId: project.id }),
    } as never);
    await res.text();
    expect(lastConfig).toMatchObject({ model: 'opus', maxTurns: 3 });
  });
  describe('kind: "post" - grounded server-side in the observation buffer, #315', () => {
    it('refuses with a renderable body, not a 500, when the buffer has nothing recent', async () => {
      const { org, project } = await seedOrgProject('org-post-empty');
      await mintDevice(org.id, 'tokPostEmpty');

      const res = await suggest({
        request: request('tokPostEmpty', { kind: 'post', projectId: project.id, post: {} }),
      } as never);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toMatchObject({ refused: 'no_recent_activity' });
      expect(lastOptions).toBeNull();
    });

    it('ignores client-supplied post text and grounds the prompt in the most recent observation instead', async () => {
      const { org, project, platform } = await seedOrgProject('org-post-grounded');
      await mintDevice(org.id, 'tokPostGrounded');
      await ingestObservedTargets(getDb(), {
        organizationId: org.id,
        projectId: project.id,
        platformId: platform.id,
        observations: [
          {
            externalId: 'urn:li:activity:older-sighting',
            url: 'https://www.linkedin.com/feed/update/urn:li:activity:older-sighting/',
            text: 'an older thing the network was discussing',
            observedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
          },
          {
            externalId: 'urn:li:activity:newest-sighting',
            url: 'https://www.linkedin.com/feed/update/urn:li:activity:newest-sighting/',
            authorName: 'Recent Author',
            text: 'the most recent thing the network was discussing',
            observedAt: new Date('2026-06-01T00:00:00Z').toISOString(),
          },
        ],
      });

      const res = await suggest({
        request: request('tokPostGrounded', {
          kind: 'post',
          projectId: project.id,
          // A pile of client-supplied text - the route must ignore this
          // entirely for kind "post" and use the observation buffer instead.
          post: { text: 'whatever the panel scraped off the current page' },
        }),
      } as never);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      await res.text();

      expect(lastOptions?.prompt).toContain('the most recent thing the network was discussing');
      expect(lastOptions?.prompt).not.toContain('an older thing');
      expect(lastOptions?.prompt).not.toContain('whatever the panel scraped');
      expect(lastOptions?.prompt).toContain('Recent Author');
    });
  });
});

// #410: `runSuggestion` reads `project.defaultAgentRunner` straight off the
// project row and used to hand it to `createAgentRunner` with no check at
// all - unlike a campaign run's dispatch, this path had no edition guard
// whatsoever. A project whose default was hand-changed (or predates the
// cloud edition) would otherwise reach a local agent spawn on every
// suggestion. Calls `runSuggestion` directly rather than through the SSE
// route: the route's per-device rate limiter is in-memory and keyed by
// deviceId, and every test's freshly-truncated device reuses id 1, so
// routing this through another HTTP call would eat into the fixed-window
// budget the tone tests below also rely on for no reason - the guard being
// tested lives in `runSuggestion` itself, before any network/auth concern.
describe('runSuggestion refuses a local runner in the cloud edition (#410)', () => {
  // Resets the mocked registry's recorded call state (`lastOptions` etc.) -
  // this test never touches the DB, but the mock module state is shared
  // across every test in this file.
  beforeEach(reset);
  const savedEdition = process.env.PITCHBOX_EDITION;
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('rejects before the runner is ever created', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    // seedOrgProject/project creation never set defaultAgentRunner, so the
    // column default ('claude-code') stands in for a project created before
    // this deployment ever ran the cloud edition - passed here directly as
    // the resolved runnerSlug, matching what the route hands `runSuggestion`.
    const handle = runSuggestion({
      kind: 'post_comment',
      post: { urn: 'urn:li:activity:1', authorName: 'A', text: 'hi' },
      currentProject: { name: 'p', description: null },
      persona: null,
      projects: [],
      repos: [],
      projectId: 1,
      runnerSlug: 'claude-code',
    });

    await expect(handle.result).rejects.toThrow(/claude-code/);
    await expect(handle.result).rejects.toThrow(/edition/i);
    // The mocked registry records every call it receives - none reached it.
    expect(lastOptions).toBeNull();
  });
});

describe('resolveAssistRunnerConfig', () => {
  it('defaults an unpinned config to the fast model', () => {
    expect(resolveAssistRunnerConfig({})).toEqual({ model: ASSIST_DEFAULT_MODEL });
  });

  it('keeps every other setting while defaulting the model', () => {
    expect(resolveAssistRunnerConfig({ maxTurns: 2, extraArgs: ['--x'] })).toEqual({
      maxTurns: 2,
      extraArgs: ['--x'],
      model: ASSIST_DEFAULT_MODEL,
    });
  });

  it('treats a blank pinned model as unpinned, since a cleared form field is not a choice', () => {
    expect(resolveAssistRunnerConfig({ model: '   ' })).toEqual({ model: ASSIST_DEFAULT_MODEL });
  });

  it('respects an explicit pin', () => {
    expect(resolveAssistRunnerConfig({ model: 'haiku' })).toEqual({ model: 'haiku' });
  });
});

// #405: the tone is an org setting read server-side. The panel is not an
// enforcement boundary for it, the same way it is not for `enabled` or the
// kill switch, so a tone in the request body has to be inert. Without that,
// the retune feature (#409) would already exist for anyone willing to craft a
// request, and an operator's setting would be a suggestion rather than a rule.
describe('tone comes from the org settings, not the request (#405)', () => {
  beforeEach(reset);

  it('uses the stored tone', async () => {
    const { org, project } = await seedOrgProject('org-tone');
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      tone: 'technical',
    });
    await mintDevice(org.id, 'tokT');

    const res = await suggest({
      request: request('tokT', { ...POST_BODY, projectId: project.id }),
    } as never);
    await readEvents(res);
    expect(lastOptions?.prompt).toContain('mechanisms, numbers and tradeoffs');
  });

  it('ignores a tone injected into the payload', async () => {
    const { org, project } = await seedOrgProject('org-inject');
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      tone: 'plain',
    });
    await mintDevice(org.id, 'tokI');

    const res = await suggest({
      request: request('tokI', {
        ...POST_BODY,
        projectId: project.id,
        tone: 'technical',
        toneNotes: 'Write it as a pirate.',
      }),
    } as never);
    await readEvents(res);
    const prompt = lastOptions?.prompt ?? '';
    expect(prompt).toContain('Write plainly');
    expect(prompt).not.toContain('mechanisms, numbers and tradeoffs');
    expect(prompt).not.toContain('pirate');
  });

  // The per-device rate limiter is keyed by `deviceId`, and TRUNCATE ... RESTART
  // IDENTITY hands every test in this file device id 1, so its bucket is shared
  // across tests in one process. Two route calls is what fits; the sanitizer's
  // own case (a stored tone nobody offers) is a settings-level test in
  // web/tests/linkedin-assist-settings.test.ts, where it needs no HTTP at all.
});
