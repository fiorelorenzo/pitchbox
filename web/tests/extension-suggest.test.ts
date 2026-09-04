import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';

/**
 * The real-time suggestion endpoint (#312). What these tests defend is the
 * enforcement boundary and the stream's contract, because the panel is not the
 * boundary: auth, cross-tenant scoping, an exhausted quota, incremental
 * delivery, and a disconnect actually cancelling the model call rather than
 * leaving it running for nobody.
 *
 * The agent itself is the one thing faked. Everything below it is real: the
 * route, the quota read, the prompt composition and the SSE framing.
 */

const chunks = ['A specific ', 'thing that ', 'happened.'];
let lastOptions: AgentRunOptions | null = null;
let cancelCalls = 0;
/** Set by a test to hold the fake agent open so a disconnect can be observed. */
let hangForever = false;

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      lastOptions = opts;
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
      for (const c of chunks) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({
          exitCode: 0,
          logPath: '/dev/null',
          usage: {
            inputTokens: 1200,
            outputTokens: 40,
            cacheReadTokens: 0,
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
const { runSuggestion } = await import('../src/lib/server/suggest.js');

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
  cancelCalls = 0;
  hangForever = false;
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
    // Incremental: one event per chunk, not one event carrying the whole answer.
    expect(kinds.filter((k) => k === 'chunk')).toHaveLength(chunks.length);
    expect(kinds).toContain('status');
    expect(kinds[kinds.length - 1]).toBe('done');

    const done = events.at(-1)!.data as { text: string; usage?: { outputTokens: number } };
    expect(done.text).toBe(chunks.join(''));
    expect(done.usage?.outputTokens).toBe(40);
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
      project: { name: project.name, description: project.description },
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
});
