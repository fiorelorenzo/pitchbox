import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AgentRunHandle, AgentRunOptions, AgentRunner } from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { ASSIST_TOOLS } from '@pitchbox/shared/assist/tools';
import {
  ASSIST_MAX_STEPS,
  ASSIST_SOFT_BUDGET_MS,
  ASSIST_TOKEN_BUDGET,
  ASSIST_COST_CEILING_USD,
} from '@pitchbox/shared/assist/budget';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #566: `runSuggestion`'s middle now builds the in-page assistant's tool
 * context and hands it to the runner. This file pins that wiring in
 * isolation from a real model loop - a fake `AgentRunner` just captures what
 * `runSuggestion` handed it, the way `extension-suggest.test.ts` already
 * does for the route's other options. The loop mechanics themselves
 * (multi-step, parallel calls, budget enforcement, cancellation, usage
 * summed across steps) are exercised end to end, against a real `SdkRunner`
 * and a fake model, in extension-suggest-loop.test.ts.
 */

let lastOptions: AgentRunOptions | null = null;

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'fake',
    run(opts: AgentRunOptions): AgentRunHandle {
      lastOptions = opts;
      opts.onTextChunk?.(`Fine.\n${DRAFT_MARKER}\nOk.`);
      return {
        result: Promise.resolve({ exitCode: 0, logPath: '/dev/null' }),
        cancel: () => {},
      };
    },
  }),
}));

// Dynamic, matching every other route/suggest test in this repo: `vi.mock`
// above is hoisted, but the mocked module graph must not resolve until
// after that registration runs, and a static import this early would race
// it and pick up the real registry instead of the fake one.
const { runSuggestion } = await import('../src/lib/server/suggest.js');

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  lastOptions = null;
}

async function seedOrgProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `p-${slug}`,
      name: slug,
      description: `about ${slug}`,
    })
    .returning();
  return { org, project };
}

describe('runSuggestion: assist tool surface wiring (#566)', () => {
  beforeEach(reset);

  it('attaches exactly the seven assist tools and the exact ASSIST_* budget - never the campaign tool set', async () => {
    const { org, project } = await seedOrgProject('org-loop-wiring');

    const handle = runSuggestion({
      kind: 'post_comment',
      post: { urn: 'urn:li:activity:1', authorName: 'A', text: 'hi' },
      currentProject: { name: project.name, description: project.description },
      persona: null,
      voiceProfile: null,
      projects: [],
      repos: [],
      projectId: project.id,
      orgId: org.id,
      runnerSlug: 'cloud',
    });
    await handle.result;

    // `attachMcp: false` unchanged - a direct tool set wins over it entirely
    // (SdkRunner never even looks at attachMcp once opts.tools is set), and
    // this is the marker that the campaign MCP tool set was never requested.
    expect(lastOptions?.attachMcp).toBe(false);
    expect(Object.keys(lastOptions?.tools ?? {}).sort()).toEqual(
      ASSIST_TOOLS.map((t) => t.name).sort(),
    );
    expect(lastOptions?.toolLoopBudget).toEqual({
      maxSteps: ASSIST_MAX_STEPS,
      softBudgetMs: ASSIST_SOFT_BUDGET_MS,
      tokenBudget: ASSIST_TOKEN_BUDGET,
      costCeilingUsd: ASSIST_COST_CEILING_USD,
    });
  });

  it('scopes the tool context to the bound project and the observed post, never a model-supplied id', async () => {
    const { org, project } = await seedOrgProject('org-loop-ctx');
    const { project: otherProject } = await seedOrgProject('org-loop-ctx-other');

    const handle = runSuggestion({
      kind: 'post_comment',
      post: {
        urn: 'urn:li:activity:2',
        authorName: 'A',
        text: 'hi',
        thread: { comments: [{ body: 'nice post' }], renderedCount: 1, truncated: false },
      },
      currentProject: { name: project.name, description: project.description },
      persona: null,
      voiceProfile: null,
      projects: [],
      repos: [],
      projectId: project.id,
      orgId: org.id,
      runnerSlug: 'cloud',
    });
    await handle.result;

    const tools = lastOptions?.tools as Record<
      string,
      { execute: (args: unknown, opts: unknown) => Promise<{ ok: boolean; data?: unknown }> }
    >;
    // read_thread reads the real observed target `runSuggestion` was called
    // with, not an empty context.
    const threadResult = (await tools.read_thread.execute({}, {})) as {
      ok: boolean;
      data: { comments: unknown[] };
    };
    expect(threadResult.ok).toBe(true);
    expect(threadResult.data.comments).toHaveLength(1);

    // project_knowledge validates a model-supplied project id against the
    // binding - a project belonging to a different org must be refused
    // rather than answered.
    const otherResult = (await tools.project_knowledge.execute(
      { projectId: otherProject.id },
      {},
    )) as { ok: boolean };
    expect(otherResult.ok).toBe(false);
  });
});
