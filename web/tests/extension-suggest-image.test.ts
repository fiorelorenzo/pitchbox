import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';
import { MAX_IMAGE_DATA_URL_CHARS } from '@pitchbox/shared/assist/suggest-prompt';

/**
 * #569: the zod schema on POST /api/extension/suggest is the enforcement
 * boundary for the post's attached media, not the extension's own clamp - a
 * stale build or a crafted request must not reach the model with a payload
 * past the cap, or one whose `dataUrl` isn't actually an image data URL.
 * Kept in its own file for the same reason extension-suggest-thread.test.ts
 * is: `perDevice`'s rate limiter is a module-level singleton shared by every
 * test that imports the route within one process.
 */

const REASONING = 'Noticed the chart in the screenshot.';
const DRAFT = 'That growth curve is the whole story.';
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

// Dynamic on purpose: `vi.mock` above is hoisted, but the route module has to
// load after that mock is registered - a static import here would race it.
// Same pattern as extension-suggest-thread.test.ts.
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

describe('the attached image (#569): the schema rejects what the cap forbids', () => {
  beforeEach(reset);

  it('accepts an image within the cap and streams normally', async () => {
    const { org, project } = await seedOrgProject('org-image-ok');
    await mintDevice(org.id, 'tok-image-ok');

    const res = await suggest({
      request: request('tok-image-ok', {
        ...POST_BODY,
        projectId: project.id,
        post: {
          ...POST_BODY.post,
          image: { dataUrl: 'data:image/jpeg;base64,AAAA', kind: 'image' },
        },
      }),
    } as never);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('accepts an image with no dataUrl at all - the capture-unavailable, alt-only fallback', async () => {
    const { org, project } = await seedOrgProject('org-image-alt-only');
    await mintDevice(org.id, 'tok-image-alt-only');

    const res = await suggest({
      request: request('tok-image-alt-only', {
        ...POST_BODY,
        projectId: project.id,
        post: {
          ...POST_BODY.post,
          image: { alt: 'a bar chart', kind: 'image', partial: false },
        },
      }),
    } as never);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  // Hostile fixture (#569 acceptance): an oversized image, whether from a
  // stale extension build or a crafted request, must never reach the model.
  it('rejects a dataUrl longer than MAX_IMAGE_DATA_URL_CHARS', async () => {
    const { org, project } = await seedOrgProject('org-image-oversized');
    await mintDevice(org.id, 'tok-image-oversized');

    const oversized = `data:image/jpeg;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS + 1)}`;
    await expect(
      suggest({
        request: request('tok-image-oversized', {
          ...POST_BODY,
          projectId: project.id,
          post: { ...POST_BODY.post, image: { dataUrl: oversized, kind: 'image' } },
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a dataUrl exactly at the cap', async () => {
    const { org, project } = await seedOrgProject('org-image-at-cap');
    await mintDevice(org.id, 'tok-image-at-cap');

    const prefix = 'data:image/jpeg;base64,';
    const atCap = prefix + 'A'.repeat(MAX_IMAGE_DATA_URL_CHARS - prefix.length);
    expect(atCap.length).toBe(MAX_IMAGE_DATA_URL_CHARS);

    const res = await suggest({
      request: request('tok-image-at-cap', {
        ...POST_BODY,
        projectId: project.id,
        post: { ...POST_BODY.post, image: { dataUrl: atCap, kind: 'image' } },
      }),
    } as never);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('rejects a dataUrl that is not an image data URL at all - a licdn URL handed over instead of pixels', async () => {
    const { org, project } = await seedOrgProject('org-image-not-a-data-url');
    await mintDevice(org.id, 'tok-image-not-a-data-url');

    await expect(
      suggest({
        request: request('tok-image-not-a-data-url', {
          ...POST_BODY,
          projectId: project.id,
          post: {
            ...POST_BODY.post,
            image: { dataUrl: 'https://media.licdn.com/dms/image/abc.jpg', kind: 'image' },
          },
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a media kind outside the three the extension can actually report', async () => {
    const { org, project } = await seedOrgProject('org-image-bad-kind');
    await mintDevice(org.id, 'tok-image-bad-kind');

    await expect(
      suggest({
        request: request('tok-image-bad-kind', {
          ...POST_BODY,
          projectId: project.id,
          post: { ...POST_BODY.post, image: { alt: 'x', kind: 'gif' } },
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });
});
