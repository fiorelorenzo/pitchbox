import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { runCampaignSkillGeneration } from '$lib/server/runner.js';

const Body = z.object({
  projectId: z.number().int().positive(),
  platformSlug: z.string().min(1),
  scenarioSlug: z.enum(['reddit-scout', 'reddit-commenter']),
  name: z.string().min(1).max(120),
  agentRunner: z.string().min(1).default('claude-code'),
  objective: z.string().min(1).max(2000),
  cronExpression: z.string().min(1).optional(),
});

export async function POST({ request }) {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const db = getDb();

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
