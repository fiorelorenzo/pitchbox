// A run can only work if the runner slug snapshotted at creation time is one
// this deployment can actually launch. Before #219 the creation default was the
// literal 'claude-code' in the request schemas, so a cloud-edition install (no
// local agent CLI in the image, by design) handed every new project a runner it
// could never spawn: the dispatch honored the snapshot, spawned the ACP adapter
// via npx and failed with "ACP initialize timed out" ~10s later. The admin's
// Settings choice (app_config.default_runner) was write-only - nothing read it.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '@pitchbox/shared/db';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';
import { POST as projectsPost } from '../src/routes/api/projects/+server.js';
import { POST as campaignsPost } from '../src/routes/api/campaigns/+server.js';
import { runProjectExtraction } from '../src/lib/server/runner.js';

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
    locals: { org: { id: orgId, slug: 'default', role: 'owner' } },
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

describe('runner snapshot defaults (#219)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  const savedRunnerUrl = process.env.PITCHBOX_RUNNER_URL;

  beforeEach(reset);
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    if (savedRunnerUrl === undefined) delete process.env.PITCHBOX_RUNNER_URL;
    else process.env.PITCHBOX_RUNNER_URL = savedRunnerUrl;
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
  beforeEach(reset);

  it('fails the run with an actionable error instead of timing out on the spawn', async () => {
    // 'cloud' with no PITCHBOX_EDITION/PITCHBOX_RUNNER_URL is the inverse of the
    // preview incident and is conclusively unavailable here, so nothing spawns.
    delete process.env.PITCHBOX_EDITION;
    clearDetectionCache();
    const projectId = await createProject('Unlaunchable', { defaultAgentRunner: 'cloud' });

    const started = Date.now();
    const { runId } = await runProjectExtraction(projectId, { kind: 'folder', value: '/tmp' });
    const [run] = await getDb()
      .select({ status: schema.runs.status, error: schema.runs.error })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/cloud/);
    expect(run.error).toMatch(/not available/i);
    // The bug was a 10s ACP initialize timeout; the guard is a pre-flight check.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
