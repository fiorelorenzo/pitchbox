import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { runCampaignSkillGeneration } from '$lib/server/runner.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { SCENARIO_SLUGS } from '@pitchbox/shared/campaigns';

const Body = z.object({
  projectId: z.number().int().positive(),
  platformSlug: z.string().min(1),
  scenarioSlug: z.enum(SCENARIO_SLUGS),
  name: z.string().min(1).max(120),
  agentRunner: z.string().min(1).default('claude-code'),
  objective: z.string().min(1).max(2000),
  cronExpression: z.string().min(1).optional(),
  // Opt-in per-campaign auto-post (MAS-5): off by default, keeping the
  // human-in-the-loop send as the default for every platform.
  autoPost: z.boolean().optional().default(false),
});

export async function POST(event: RequestEvent) {
  const { request } = event;
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const db = getDb();

  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(db, body.projectId, orgId))) throw error(404, 'not_found');

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, body.projectId));
  if (!project) return json({ error: 'project_not_found' }, { status: 400 });

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platformSlug));
  if (!platform) return json({ error: 'platform_not_found' }, { status: 400 });

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: body.projectId,
      platformId: platform.id,
      name: body.name,
      skillSlug: body.scenarioSlug,
      agentRunner: body.agentRunner,
      cronExpression: body.cronExpression ?? null,
      status: 'draft',
      config: {},
      autoPost: body.autoPost,
    })
    .returning();

  let runId: number;
  try {
    const out = await runCampaignSkillGeneration(campaign.id, body.scenarioSlug, body.objective);
    runId = out.runId;
  } catch (e) {
    return json(
      { error: 'dispatch_failed', message: String((e as Error).message), id: campaign.id },
      { status: 500 },
    );
  }

  return json({ id: campaign.id, runId }, { status: 201 });
}
