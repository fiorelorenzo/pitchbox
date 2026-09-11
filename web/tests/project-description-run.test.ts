// A description run reads the project's whole active source set, and the
// endpoint that starts one takes no body at all.
//
// That is the shape the sources panel depends on: add a source, press one
// button, done. It replaced a POST that required one `{ kind, value }`
// source picked in the UI, which is why the panel used to carry a play
// button per row and why adding a source did nothing on its own.
//
// Two things here are worth defending against a regression. A project with
// no active source must be refused before a run row exists: an agent asked
// to describe nothing either invents a product or dies on its first tool
// call, and both are worse than a refusal the operator can act on. And the
// run has to record which sources it was started over, since the extraction
// history column shows it and a run log with no record of its inputs cannot
// be read after the fact.
import { describe, expect, it, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { createProjectSource, updateProjectSource } from '@pitchbox/shared/project-sources';
import { POST } from '../src/routes/api/projects/[id]/runs/+server.js';

// Nothing here mocks the runner: the project's snapshotted runner is one
// this test deployment cannot launch, so the run row is inserted and then
// fails fast on the pre-flight guard (the same seam runner-defaults.test.ts
// uses). That keeps this file about the endpoint's contract - refusal,
// status codes, and what lands in `runs.params` - without spawning an agent.

async function seedProject(): Promise<{ orgId: number; projectId: number }> {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `desc-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Description run',
      // A runner this deployment cannot launch fails the run after it is
      // inserted, which is all this file needs: it asserts on the row and
      // the response, never on a successful agent.
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function ev(orgId: number, projectId: number) {
  return {
    locals: { org: { id: orgId, slug: 'default', role: 'owner' }, locale: 'en' },
    params: { id: String(projectId) },
    request: new Request('http://x/', { method: 'POST' }),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/projects/[id]/runs', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE runs RESTART IDENTITY CASCADE`);
  });

  it('refuses a project with no source instead of starting a run that has nothing to read', async () => {
    const { orgId, projectId } = await seedProject();

    const res = await POST(ev(orgId, projectId));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_sources' });
    const runs = await getDb()
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.projectId, projectId));
    expect(runs).toHaveLength(0);
  });

  it('refuses a project whose only source was deactivated', async () => {
    const { orgId, projectId } = await seedProject();
    const source = await createProjectSource(getDb(), orgId, projectId, 'website', {
      url: 'https://example.com',
    });
    await updateProjectSource(getDb(), orgId, source!.id, { active: false });

    const res = await POST(ev(orgId, projectId));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_sources' });
  });

  it('starts one run over every active source, with no body, recording their ids', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = await createProjectSource(getDb(), orgId, projectId, 'git', {
      value: 'https://github.com/acme/widget',
    });
    const site = await createProjectSource(getDb(), orgId, projectId, 'website', {
      url: 'https://example.com',
    });
    const inactive = await createProjectSource(getDb(), orgId, projectId, 'hackernews_author', {
      username: 'pg',
    });
    await updateProjectSource(getDb(), orgId, inactive!.id, { active: false });

    const res = await POST(ev(orgId, projectId));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: number };
    const [run] = await getDb()
      .select({ params: schema.runs.params, kind: schema.runs.kind })
      .from(schema.runs)
      .where(eq(schema.runs.id, body.runId));
    expect(run.kind).toBe('project_extraction');
    // The row was just written by `runProjectExtraction`, so its params
    // shape is this codebase's own, not outside input.
    const params = run.params as { sourceIds: number[] };
    expect(params.sourceIds.sort()).toEqual([repo!.id, site!.id].sort());
  });

  it('refuses a second concurrent run for the same project with 409', async () => {
    const { orgId, projectId } = await seedProject();
    await createProjectSource(getDb(), orgId, projectId, 'website', {
      url: 'https://example.com',
    });
    await getDb()
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId,
        agentRunner: 'claude-code',
        trigger: 'manual',
        status: 'running',
        params: { sourceIds: [] },
      });

    const res = await POST(ev(orgId, projectId));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_running' });
    const running = await getDb()
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.status, 'running')));
    expect(running).toHaveLength(1);
  });
});
