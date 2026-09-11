// A run can only work if the runner slug snapshotted at creation time is one
// this deployment can actually launch. Before #219 the creation default was the
// literal 'claude-code' in the request schemas, so a cloud-edition install (no
// local agent CLI in the image, by design) handed every new project a runner it
// could never spawn: the dispatch honored the snapshot, spawned the ACP adapter
// via npx and failed with "ACP initialize timed out" ~10s later. The admin's
// Settings choice (app_config.default_runner) was write-only - nothing read it.
//
// #410 closes the follow-on gap: before this file's second half, none of the
// four write routes (or the campaign-creation inherit path, or project
// creation's own explicit-slug back door) rejected a local slug in the cloud
// edition - only dispatch did, and only when the local CLI happened to be
// undetected. A cloud container that happens to have `claude`/`codex` on
// PATH for unrelated reasons made detection lie and dispatch let it through.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '@pitchbox/shared/db';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';
import { POST as projectsPost } from '../src/routes/api/projects/+server.js';
import { POST as campaignsPost } from '../src/routes/api/campaigns/+server.js';
import { PATCH as campaignsPatch } from '../src/routes/api/campaigns/[id]/+server.js';
import {
  GET as projectsGet,
  PATCH as projectsPatch,
} from '../src/routes/api/projects/[id]/+server.js';
import { PUT as defaultRunnerPut } from '../src/routes/api/settings/default-runner/+server.js';
import { runProjectExtraction } from '../src/lib/server/runner.js';
import { createProjectSource } from '@pitchbox/shared/project-sources';

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM app_config WHERE key = 'default_runner'`);
  clearDetectionCache();
}

async function defaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

// The two route handlers are typed with their own generated RequestEvent, so
// the shape is built once and cast to whichever the call site needs - the same
// `Parameters<typeof handler>[0]` seam the extension-dm-sync tests use.
function postEvent<T>(orgId: number, body: unknown): T {
  return {
    // `locale` matches what hooks.server.ts always populates in production
    // (LOR-260); the runner_not_allowed message is resolved through it, so
    // an event missing it would crash rather than silently rendering English.
    locals: { org: { id: orgId, slug: 'default', role: 'owner' }, locale: 'en' },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as T;
}

async function setConfiguredDefault(slug: string): Promise<void> {
  await getDb()
    .insert(schema.appConfig)
    .values({ key: 'default_runner', value: { slug } })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: { slug } } });
}

const CreatedProject = z.object({ id: z.number() });

async function createProject(name: string, body: Record<string, unknown> = {}): Promise<number> {
  const res = await projectsPost(postEvent(await defaultOrgId(), { name, ...body }));
  expect(res.status).toBe(201);
  return CreatedProject.parse(await res.json()).id;
}

async function runnerOf(projectId: number): Promise<string> {
  const [row] = await getDb()
    .select({ runner: schema.projects.defaultAgentRunner })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return row.runner;
}

function patchEvent<T>(orgId: number, id: number, body: unknown): T {
  return {
    locals: { org: { id: orgId, slug: 'default', role: 'owner' }, locale: 'en' },
    params: { id: String(id) },
    request: new Request(`http://x/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as T;
}

function getEvent<T>(orgId: number, id: number): T {
  return {
    locals: { org: { id: orgId, slug: 'default', role: 'owner' } },
    params: { id: String(id) },
  } as unknown as T;
}

function putEvent<T>(body: unknown): T {
  return {
    locals: {},
    request: new Request('http://x/', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as T;
}

async function createCampaign(
  projectId: number,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: { error?: string; id?: number } }> {
  const res = await campaignsPost(
    postEvent(await defaultOrgId(), {
      projectId,
      platformSlug: 'reddit',
      scenarioSlug: 'reddit-scout',
      name: 'c',
      objective: 'find people',
      ...body,
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe('runner snapshot defaults (#219)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;

  beforeEach(reset);
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    clearDetectionCache();
  });

  it('a new project snapshots the runner an admin configured in Settings', async () => {
    await setConfiguredDefault('cloud');
    expect(await runnerOf(await createProject('Configured'))).toBe('cloud');
  });

  it('an explicit runner in the request still wins over the configured default', async () => {
    await setConfiguredDefault('cloud');
    const id = await createProject('Explicit', { defaultAgentRunner: 'codex' });
    expect(await runnerOf(id)).toBe('codex');
  });

  it('with nothing configured, the cloud edition defaults to the cloud runner', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    expect(await runnerOf(await createProject('Cloud edition'))).toBe('cloud');
  });

  it('with nothing configured, a self-hosted install still defaults to claude-code', async () => {
    delete process.env.PITCHBOX_EDITION;
    expect(await runnerOf(await createProject('Self hosted'))).toBe('claude-code');
  });

  it('a campaign inherits its project runner when the request does not name one', async () => {
    await setConfiguredDefault('cloud');
    const projectId = await createProject('Inheriting');
    const res = await campaignsPost(
      postEvent(await defaultOrgId(), {
        projectId,
        platformSlug: 'reddit',
        scenarioSlug: 'reddit-scout',
        name: 'c',
        objective: 'find people',
      }),
    );
    expect(res.status).toBe(201);
    const [campaign] = await getDb()
      .select({ runner: schema.campaigns.agentRunner })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.projectId, projectId));
    expect(campaign.runner).toBe('cloud');
  });
});

describe('dispatch refuses a runner this deployment cannot launch (#219)', () => {
  const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(reset);
  afterEach(() => {
    if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
    clearDetectionCache();
  });

  it('fails the run with an actionable error instead of timing out on the spawn', async () => {
    // 'cloud' with no AI_GATEWAY_API_KEY is the inverse of the preview incident
    // and is conclusively unavailable here, so nothing spawns.
    delete process.env.AI_GATEWAY_API_KEY;
    clearDetectionCache();
    const projectId = await createProject('Unlaunchable', { defaultAgentRunner: 'cloud' });

    const started = Date.now();
    // A description run reads the project's source set, so the project needs
    // one active source for there to be a run at all.
    await createProjectSource(getDb(), await defaultOrgId(), projectId, 'folder', {
      value: '/tmp',
    });
    const { runId } = await runProjectExtraction(projectId);
    expect(runId).toBeDefined();
    const [run] = await getDb()
      .select({ status: schema.runs.status, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId!));

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/cloud/);
    expect(run.error).toMatch(/not available/i);
    // The bug was a 10s ACP initialize timeout; the guard is a pre-flight check.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('cloud edition rejects a local runner slug at the API boundary (#410)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(reset);
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    clearDetectionCache();
  });

  it('POST /api/campaigns refuses an explicit local runner', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const projectId = await createProject('Cloud project');
    const { status, body } = await createCampaign(projectId, { agentRunner: 'claude-code' });
    expect(status).toBe(400);
    expect(body.error).toBe('runner_not_allowed');
  });

  it('POST /api/campaigns refuses a new campaign that would inherit a disallowed project default', async () => {
    // The project predates the cloud edition (or the guard): it was allowed
    // to snapshot claude-code while self-hosted. A new campaign that never
    // names a runner itself still resolves to it by inheritance, and that
    // resolution is a new write like any other.
    delete process.env.PITCHBOX_EDITION;
    const projectId = await createProject('Legacy local default', {
      defaultAgentRunner: 'claude-code',
    });
    process.env.PITCHBOX_EDITION = 'cloud';
    const { status, body } = await createCampaign(projectId);
    expect(status).toBe(400);
    expect(body.error).toBe('runner_not_allowed');
  });

  it('PATCH /api/campaigns/[id] refuses an explicit local runner', async () => {
    delete process.env.PITCHBOX_EDITION;
    const projectId = await createProject('Patch campaign project');
    const { body: created } = await createCampaign(projectId);
    const campaignId = created.id as number;
    process.env.PITCHBOX_EDITION = 'cloud';

    const res = await campaignsPatch(
      patchEvent(await defaultOrgId(), campaignId, { agentRunner: 'codex' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('runner_not_allowed');

    const [campaign] = await getDb()
      .select({ runner: schema.campaigns.agentRunner })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(campaign.runner).toBe('claude-code');
  });

  it('PATCH /api/projects/[id] refuses an explicit local runner', async () => {
    delete process.env.PITCHBOX_EDITION;
    const projectId = await createProject('Patch project');
    process.env.PITCHBOX_EDITION = 'cloud';

    const res = await projectsPatch(
      patchEvent(await defaultOrgId(), projectId, { defaultAgentRunner: 'gemini' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('runner_not_allowed');
    expect(await runnerOf(projectId)).toBe('claude-code');
  });

  it('PUT /api/settings/default-runner refuses a local runner', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    // The route throws SvelteKit's `error()` helper rather than returning a
    // Response - calling the handler directly (no request-handling
    // machinery to catch it) surfaces that as a rejection.
    await expect(defaultRunnerPut(putEvent({ slug: 'claude-code' }))).rejects.toMatchObject({
      status: 400,
      body: { message: 'runner_not_allowed' },
    });
  });

  it('POST /api/projects refuses an explicit local runner (the resolver back door)', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const res = await projectsPost(
      postEvent(await defaultOrgId(), { name: 'Direct call', defaultAgentRunner: 'opencode' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('runner_not_allowed');
  });
});

describe('an existing local snapshot survives the cloud edition guard (#410)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(reset);
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    clearDetectionCache();
  });

  it('a read of the project still loads and shows the pre-existing local runner', async () => {
    delete process.env.PITCHBOX_EDITION;
    const projectId = await createProject('Pre-existing', { defaultAgentRunner: 'claude-code' });
    process.env.PITCHBOX_EDITION = 'cloud';

    const res = await projectsGet(getEvent(await defaultOrgId(), projectId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.defaultAgentRunner).toBe('claude-code');
  });

  it('dispatch refuses the pre-existing local runner with a readable reason instead of spawning it', async () => {
    delete process.env.PITCHBOX_EDITION;
    const projectId = await createProject('Pre-existing dispatch', {
      defaultAgentRunner: 'claude-code',
    });
    process.env.PITCHBOX_EDITION = 'cloud';
    clearDetectionCache();

    const started = Date.now();
    await createProjectSource(getDb(), await defaultOrgId(), projectId, 'folder', {
      value: '/tmp',
    });
    const { runId } = await runProjectExtraction(projectId);
    expect(runId).toBeDefined();
    const [run] = await getDb()
      .select({ status: schema.runs.status, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId!));

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/claude-code/);
    expect(run.error).toMatch(/edition/i);
    // Refusing on the edition check happens before the detection probe or any
    // spawn attempt, so this stays fast the same way the #219 guard does.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
