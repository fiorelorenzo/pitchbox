import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import { type RunnerConfig } from '@pitchbox/shared/agents/config';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';
import {
  MAX_COMMENT_CHARS,
  MAX_THREAD_CHARS,
  MAX_THREAD_COMMENTS,
} from '@pitchbox/shared/assist/suggest-prompt';

/**
 * #568: the zod schema on POST /api/extension/suggest is the enforcement
 * boundary for the visible thread, not the extension's own clamp - a stale
 * build or a crafted request must not reach the model with more than the
 * three caps allow. Kept in its own file rather than folded into
 * extension-suggest.test.ts because that file's `perDevice` rate limiter
 * (20/60s) is a module-level singleton shared by every test in the process
 * that imports it, and its own tests already run it close to the cap (see
 * the comment on its last describe block) - a fresh file gets a fresh
 * import and a fresh limiter.
 */

const REASONING = 'Noticed the cache change and the specific number.';
const DRAFT = 'A specific thing that happened.';
const ENVELOPE_CHUNKS = [`${REASONING}\n`, DRAFT_MARKER, '\n', DRAFT];
let responseChunks: string[] = ENVELOPE_CHUNKS;

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      for (const c of responseChunks) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({ exitCode: 0, logPath: '/dev/null' }),
        cancel: () => {},
      };
    },
  }),
}));

// Dynamic on purpose: `vi.mock` above is hoisted, but the route module (and
// the `suggest.ts` it imports) has to load *after* that mock is registered
// for `createAgentRunner` to resolve to the fake - a static import here
// would race the hoisted mock. Same pattern as extension-suggest.test.ts.
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
  responseChunks = ENVELOPE_CHUNKS;
}

async function seedOrgProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug, description: `about ${slug}` })
    .returning();
  await saveLinkedInAssistSettings(db, org.id, {
    ...defaultLinkedInAssistSettings(),
    enabled: true,
    projectId: project.id,
  });
  return { org, project };
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

function request(token: string | null, body: unknown): Request {
  return new Request('http://x/api/extension/suggest', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000001',
    authorName: 'Giulia Bianchi',
    text: 'We cut p99 in half.',
  },
};

function threadOf(count: number, bodyLength: number) {
  return {
    comments: Array.from({ length: count }, (_, i) => ({
      id: `urn:li:comment:(activity:1,${i})`,
      authorName: `Commenter ${i}`,
      body: 'x'.repeat(bodyLength),
    })),
    renderedCount: count,
    truncated: false,
  };
}

describe('the visible thread (#568): the schema rejects what the caps forbid', () => {
  beforeEach(reset);

  it('accepts a thread within every cap and streams normally', async () => {
    const { org, project } = await seedOrgProject('org-thread-ok');
    await mintDevice(org.id, 'tok-thread-ok');

    const res = await suggest({
      request: request('tok-thread-ok', {
        ...POST_BODY,
        projectId: project.id,
        post: { ...POST_BODY.post, thread: threadOf(3, 80) },
      }),
    } as never);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // #616: drain to `done`, or the ledger write in the route's
    // `handle.result.then(...)` (after this call already returned) keeps
    // running past this test and races the next file's TRUNCATE.
    await res.text();
  });

  it('rejects more comments than MAX_THREAD_COMMENTS', async () => {
    const { org, project } = await seedOrgProject('org-thread-count');
    await mintDevice(org.id, 'tok-thread-count');

    await expect(
      suggest({
        request: request('tok-thread-count', {
          ...POST_BODY,
          projectId: project.id,
          post: { ...POST_BODY.post, thread: threadOf(MAX_THREAD_COMMENTS + 1, 20) },
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a single comment body longer than MAX_COMMENT_CHARS', async () => {
    const { org, project } = await seedOrgProject('org-thread-body');
    await mintDevice(org.id, 'tok-thread-body');

    await expect(
      suggest({
        request: request('tok-thread-body', {
          ...POST_BODY,
          projectId: project.id,
          post: { ...POST_BODY.post, thread: threadOf(1, MAX_COMMENT_CHARS + 1) },
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a combined comment-body length past MAX_THREAD_CHARS even though the count and each body individually stay within their own caps', async () => {
    const { org, project } = await seedOrgProject('org-thread-total');
    await mintDevice(org.id, 'tok-thread-total');

    // 20 comments (under MAX_THREAD_COMMENTS) at 400 chars each (under
    // MAX_COMMENT_CHARS) - 8000 combined, past MAX_THREAD_CHARS (6000).
    const perComment = 400;
    const count = 20;
    expect(count).toBeLessThan(MAX_THREAD_COMMENTS);
    expect(perComment).toBeLessThan(MAX_COMMENT_CHARS);
    expect(count * perComment).toBeGreaterThan(MAX_THREAD_CHARS);

    await expect(
      suggest({
        request: request('tok-thread-total', {
          ...POST_BODY,
          projectId: project.id,
          post: { ...POST_BODY.post, thread: threadOf(count, perComment) },
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });
});
