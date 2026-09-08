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

  // #409's own acceptance: a retune costs a model call, so it is bound by the
  // exact same daily cap a first suggestion is. Two real route calls, not
  // one: the first (a plain suggestion) succeeds while the account is still
  // under its cap of one; a draft is then recorded as sent directly (the
  // route itself never writes one - #313's accept path does, and only once
  // the human confirms on LinkedIn - so this stands in for that having
  // already happened once today); the second call, this time a retune,
  // reads the now-exhausted quota and refuses exactly like a first call
  // would, proving retune carries no bypass of its own.
  it('a retune counts against the caps: the second call, at a cap of one, is refused', async () => {
    const db = getDb();
    const { org, project, platform } = await seedOrgProject('org-retune-cap');
    await mintDevice(org.id, 'tokCap');
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'marco',
        dailyLimit: 1,
        active: true,
      })
      .returning();

    const first = await suggest({
      request: request('tokCap', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    await first.text();

    const [run] = await db
      .insert(schema.runs)
      .values({ kind: 'assist', projectId: project.id, trigger: 'manual', status: 'success' })
      .returning();
    await db.insert(schema.drafts).values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      // DRAFT_KINDS is 'dm' | 'post' | 'post_comment' | 'comment_reply' - a
      // plain 'comment' is not one of them and getUsageForAccounts skips
      // whatever isDraftKind rejects, so this has to match POST_BODY.kind
      // for the inserted draft to actually count toward the cap below.
      kind: 'post_comment',
      body: 'the comment sent earlier today',
      state: 'sent',
      sentAt: new Date(),
    });

    const second = await suggest({
      request: request('tokCap', { ...POST_BODY, projectId: project.id, retune: 'shorter' }),
    } as never);
    expect(second.headers.get('content-type')).toContain('application/json');
    const body = (await second.json()) as { refused: string; window: string };
    expect(body.refused).toBe('quota_exhausted');
    expect(body.window).toBe('day');
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
