import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';
import { POST as projectsPost } from '../src/routes/api/projects/+server.js';

/**
 * #548: POST /api/projects refuses a structural create once the org is at
 * its plan's project limit, with a 402-shaped body a form can render as an
 * upgrade prompt rather than a validation error.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makeOrg(slug: string, plan: string = 'free') {
  const [org] = await getDb()
    .insert(schema.organizations)
    .values({ slug, name: slug, plan })
    .returning();
  return org.id;
}

async function makeProject(orgId: number, slug: string) {
  await getDb().insert(schema.projects).values({ organizationId: orgId, slug, name: slug });
}

function postEvent(orgId: number, body: unknown): Parameters<typeof projectsPost>[0] {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as Parameters<typeof projectsPost>[0];
}

describe('POST /api/projects is plan-limit-gated (#548)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  const freeLimit = PLAN_CATALOGUE.free.projects!;

  it('refuses with a 402-shaped body once the org is at its plan project limit', async () => {
    const orgId = await makeOrg('projects-plan-limit-over');
    for (let i = 0; i < freeLimit; i += 1) await makeProject(orgId, `p${i}`);

    const res = await projectsPost(
      postEvent(orgId, { name: 'One too many', defaultAgentRunner: 'cloud' }),
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error?: string;
      metric?: string;
      limit?: number;
      used?: number;
    };
    expect(body.error).toBe('plan_limit_reached');
    expect(body.metric).toBe('projects');
    expect(body.limit).toBe(freeLimit);
    expect(body.used).toBe(freeLimit);

    const rows = await getDb()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, orgId));
    expect(rows).toHaveLength(freeLimit); // nothing created
  });

  it('an org under its plan limit creates the project normally', async () => {
    const orgId = await makeOrg('projects-plan-limit-under');
    for (let i = 0; i < freeLimit - 1; i += 1) await makeProject(orgId, `p${i}`);

    const res = await projectsPost(
      postEvent(orgId, { name: 'Just fits', defaultAgentRunner: 'cloud' }),
    );

    expect(res.status).toBe(201);
  });

  it('a self-host install refuses nothing, however many projects the org already has', async () => {
    delete process.env.PITCHBOX_EDITION;
    const orgId = await makeOrg('projects-plan-limit-self-host');
    for (let i = 0; i < freeLimit + 10; i += 1) await makeProject(orgId, `p${i}`);

    const res = await projectsPost(postEvent(orgId, { name: 'Still fine' }));

    expect(res.status).toBe(201);
  });
});
