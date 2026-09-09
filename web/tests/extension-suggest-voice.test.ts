import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import { type RunnerConfig } from '@pitchbox/shared/agents/config';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { ensurePersonalProject } from '@pitchbox/shared/personal-project';
import { loadCompanionContext } from '@pitchbox/shared/assist/context';
import { loadActiveTemplates } from '@pitchbox/shared/templates';
import { buildSuggestionPrompt } from '@pitchbox/shared/assist/suggest-prompt';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #408: a per-project voice override, resolved against the project a
 * suggestion is actually being filed under (the bound project, or the org's
 * `personal` carve-out) rather than the org's bound project alone. Kept in
 * its own file rather than folded into extension-suggest.test.ts because
 * that file's `perDevice` rate limiter (20/60s) is a module-level singleton
 * shared by every test in the process that imports it, and its own tests
 * already run it close to the cap (see the comment on its last describe
 * block) - a fresh file gets a fresh import and a fresh limiter.
 */

const REASONING = 'Noticed the cache change and the specific number.';
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
  lastOptions = null;
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

async function setProjectVoice(
  projectId: number,
  voiceTone: string | null,
  voiceToneNotes: string | null = null,
) {
  await getDb()
    .update(schema.projects)
    .set({ voiceTone, voiceToneNotes })
    .where(eq(schema.projects.id, projectId));
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

describe('per-project voice (#408)', () => {
  beforeEach(reset);

  it('the same post answered under the product project and the personal project produces different registers', async () => {
    const { org, project: product } = await seedOrgProject('voice-product');
    // Org default is 'warm'; the product project overrides to 'technical'.
    // The personal project gets no override, so it inherits the org's 'warm'.
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: product.id,
      tone: 'warm',
    });
    await setProjectVoice(product.id, 'technical');
    const personalId = await ensurePersonalProject(getDb(), org.id);
    await mintDevice(org.id, 'tok-product-vs-personal');

    const productRes = await suggest({
      request: request('tok-product-vs-personal', { ...POST_BODY, projectId: product.id }),
    } as never);
    // Drains the SSE body so the fake runner's synchronous write to
    // `lastOptions` is guaranteed to have happened before this reads it.
    await productRes.text();
    const productPrompt = lastOptions?.prompt ?? '';

    const personalRes = await suggest({
      request: request('tok-product-vs-personal', { ...POST_BODY, projectId: personalId }),
    } as never);
    await personalRes.text();
    const personalPrompt = lastOptions?.prompt ?? '';

    expect(productPrompt).toContain('mechanisms, numbers and tradeoffs');
    expect(productPrompt).not.toContain('address the author as a person');

    expect(personalPrompt).toContain('address the author as a person');
    expect(personalPrompt).not.toContain('mechanisms, numbers and tradeoffs');

    expect(productPrompt).not.toBe(personalPrompt);
  });

  it('a project with no override produces the exact prompt as before this change, byte for byte', async () => {
    const { org, project } = await seedOrgProject('voice-no-override');
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      tone: 'professional',
    });
    await mintDevice(org.id, 'tok-no-override');

    const res = await suggest({
      request: request('tok-no-override', { ...POST_BODY, projectId: project.id }),
    } as never);
    await res.text();
    const actual = lastOptions?.prompt ?? '';

    // Rebuilds the prompt exactly the way the route did before #408: the
    // tone comes straight from the org's `linkedin_assist` setting, with no
    // project-level resolution step at all. If a project with an unset
    // override still gets identical output, the resolver is a true no-op
    // for this case rather than a behavioural change in disguise.
    const db = getDb();
    const context = await loadCompanionContext(db, {
      organizationId: project.organizationId,
      currentProjectId: project.id,
    });
    const examples = (
      await loadActiveTemplates(db, { projectId: project.id, kind: 'comment' })
    ).map((t) => ({ id: t.id, title: t.title, body: t.body, createdAt: t.createdAt }));
    const expected = buildSuggestionPrompt({
      kind: 'post_comment',
      post: POST_BODY.post,
      currentProject: { name: project.name, description: project.description },
      persona: context.persona,
      // #407: the prompt carries the derived profile instead of the raw
      // sample list, and this test only cares about the tone half.
      voiceProfile: context.voiceProfile,
      projects: context.projects,
      repos: context.repos,
      examples,
      hint: undefined,
      tone: 'professional',
      toneNotes: '',
    });

    expect(actual).toBe(expected);
  });

  // Same enforcement rule as #405 (`enabled`, `killSwitch`, the org tone): a
  // project-level voice is resolved server-side too, and the extension does
  // not get a say. Distinct from the #405 test in extension-suggest.test.ts
  // because here a project override is actually in play - proving the body
  // can't override *that* either, not just the org-level fallback.
  it('ignores a tone injected into the request body even when a project override is set', async () => {
    const { org, project } = await seedOrgProject('voice-inject');
    await setProjectVoice(project.id, 'plain');
    await mintDevice(org.id, 'tok-voice-inject');

    const res = await suggest({
      request: request('tok-voice-inject', {
        ...POST_BODY,
        projectId: project.id,
        tone: 'technical',
        toneNotes: 'Write it as a pirate.',
      }),
    } as never);
    await res.text();
    const prompt = lastOptions?.prompt ?? '';

    expect(prompt).toContain('Write plainly');
    expect(prompt).not.toContain('mechanisms, numbers and tradeoffs');
    expect(prompt).not.toContain('pirate');
  });
});
