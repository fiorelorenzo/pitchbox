import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { runCampaignSkillGeneration } from '$lib/server/runner.js';
import { previewCron } from '@pitchbox/daemon/cron';
import { requireOrgId, requireVerifiedEmail } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { isRunnerAllowed } from '@pitchbox/shared/edition';
import { SCENARIO_SLUGS } from '@pitchbox/shared/campaigns';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { isOrgReadOnly } from '@pitchbox/shared/plans';
import { t } from '@pitchbox/shared/messages';

const Body = z.object({
  projectId: z.number().int().positive(),
  platformSlug: z.string().min(1),
  scenarioSlug: z.enum(SCENARIO_SLUGS),
  name: z.string().min(1).max(120),
  // Omitted = inherit the project's runner, which is itself resolved from
  // Settings / the edition at project creation (#219).
  agentRunner: z.string().min(1).optional(),
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
  await requireVerifiedEmail(event);

  // #554: a failed payment past its grace window refuses a new campaign -
  // campaigns carry no plan-limit ceiling of their own (the catalogue meters
  // projects/runs/suggestions/seats/devices, not campaign count), so this is
  // the only plan gate this route needs.
  const period = await billingPeriodFor(db, orgId);
  const usage = await getOrgUsage(db, orgId, period);
  if (isOrgReadOnly(usage.entitlements)) {
    return json({ error: 'plan_payment_required' }, { status: 402 });
  }

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, body.projectId));
  if (!project) return json({ error: 'project_not_found' }, { status: 400 });

  // The campaign's actual runner, explicit or inherited from the project - a
  // new campaign resolving to a disallowed slug is a new write either way,
  // even when the value only arrived by inheriting the project's own
  // snapshot (which itself may predate this guard or this edition).
  const effectiveRunner = body.agentRunner ?? project.defaultAgentRunner;
  if (!isRunnerAllowed(effectiveRunner)) {
    return json(
      {
        error: 'runner_not_allowed',
        message: t(event.locals.locale, 'api.runner_not_allowed', { runner: effectiveRunner }),
      },
      { status: 400 },
    );
  }

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platformSlug));
  if (!platform) return json({ error: 'platform_not_found' }, { status: 400 });

  // Validate with the exact library the scheduler daemon uses
  // (@pitchbox/daemon/cron, backed by cron-parser) so this can never
  // persist an expression the scheduler will reject at run time (#234).
  let cronExpression: string | null = null;
  if (body.cronExpression) {
    const trimmed = body.cronExpression.trim();
    const preview = previewCron(trimmed);
    if (!preview.valid) {
      return json({ error: 'invalid_cron', message: preview.error }, { status: 400 });
    }
    cronExpression = trimmed;
  }

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: body.projectId,
      platformId: platform.id,
      name: body.name,
      skillSlug: body.scenarioSlug,
      agentRunner: body.agentRunner ?? project.defaultAgentRunner,
      cronExpression,
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
