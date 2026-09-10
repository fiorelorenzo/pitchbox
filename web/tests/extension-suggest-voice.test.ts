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
import { loadCompanionContext } from '@pitchbox/shared/assist/context';
import { loadActiveTemplates } from '@pitchbox/shared/templates';
import { buildSuggestionPrompt } from '@pitchbox/shared/assist/suggest-prompt';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #408 introduced a per-project voice override, resolved against the
 * project a suggestion was filed under. LOR-181 retired that resolution at
 * this route: which project (if any) a suggestion is about is now the
 * model's own judgement, made *during* the turn (`assist/envelope.ts`'s
 * `PROJECT_MARKER`), never known ahead of building the prompt - so a
 * project's own voice override (`resolveEffectiveVoice`'s project branch,
 * still real and still covered directly by
 * `shared/tests/linkedin-assist-voice.test.ts`) can no longer be reached
 * from here. What this file defends now is the opposite of what it used
 * to: the org's own tone is what every suggestion gets, regardless of any
 * project-level override and regardless of a stale `projectId` an old
 * extension build still sends. Kept in its own file rather than folded
 * into extension-suggest.test.ts because that file's `perDevice` rate
 * limiter (20/60s) is a module-level singleton shared by every test in the
 * process that imports it, and its own tests already run it close to the
 * cap (see the comment on its last describe block) - a fresh file gets a
 * fresh import and a fresh limiter.
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

  it('a project-level voice override no longer reaches the prompt, since no project is resolved before the turn runs', async () => {
    const { org, project: product } = await seedOrgProject('voice-product');
    // Org default is 'warm'; the product project's own override to
    // 'technical' is real (`shared/tests/linkedin-assist-voice.test.ts`
    // still exercises `resolveEffectiveVoice`'s project branch directly)
    // but this route no longer has a project to resolve it against.
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: product.id,
      tone: 'warm',
    });
    await setProjectVoice(product.id, 'technical');
    await mintDevice(org.id, 'tok-product-vs-personal');

    // A stale extension build that still names the project in the request
    // body produces the exact same prompt as one that names none at all -
    // the field is inert either way (LOR-181).
    const withProjectRes = await suggest({
      request: request('tok-product-vs-personal', { ...POST_BODY, projectId: product.id }),
    } as never);
    await withProjectRes.text();
    const withProjectPrompt = lastOptions?.prompt ?? '';

    const noProjectRes = await suggest({
      request: request('tok-product-vs-personal', POST_BODY),
    } as never);
    await noProjectRes.text();
    const noProjectPrompt = lastOptions?.prompt ?? '';

    // The org's own 'warm' tone, never the product project's 'technical'
    // override - both requests land on it identically.
    expect(withProjectPrompt).toContain('address the author as a person');
    expect(withProjectPrompt).not.toContain('mechanisms, numbers and tradeoffs');
    expect(noProjectPrompt).toContain('address the author as a person');
    expect(noProjectPrompt).not.toContain('mechanisms, numbers and tradeoffs');
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
    });
    const examples = (
      await loadActiveTemplates(db, { projectId: project.id, kind: 'comment' })
    ).map((t) => ({ id: t.id, title: t.title, body: t.body, createdAt: t.createdAt }));
    const expected = buildSuggestionPrompt({
      kind: 'post_comment',
      post: POST_BODY.post,
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
  // tone in the request body is inert. LOR-181: so is a project-level
  // voice override reached through this route - there is no project known
  // yet to resolve one against, so the org's own default tone
  // (`match-room`, unset here) is what a suggestion gets regardless of
  // either.
  it('ignores both a tone injected into the request body and a project-level override', async () => {
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

    expect(prompt).toContain('Match the room');
    expect(prompt).not.toContain('Write plainly');
    expect(prompt).not.toContain('mechanisms, numbers and tradeoffs');
    expect(prompt).not.toContain('pirate');
  });
});
