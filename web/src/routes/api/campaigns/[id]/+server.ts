import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { previewCron } from '@pitchbox/daemon/cron';
import { getSchema, type ScenarioSlug } from '@pitchbox/shared/campaigns';
import {
  deleteCampaign,
  CampaignDeleteNameMismatchError,
  CampaignDeleteRunInFlightError,
} from '@pitchbox/shared/campaigns/server';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { campaignBelongsToOrg } from '@pitchbox/shared/orgs';

const Patch = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['active', 'paused']).optional(),
  cronExpression: z.string().nullable().optional(),
  agentRunner: z.string().min(1).optional(),
  // Opt-in per-campaign auto-post (MAS-5) - see the campaigns.auto_post column.
  autoPost: z.boolean().optional(),
  config: z.unknown().optional(),
});

const DeleteBody = z.object({ confirmName: z.string().min(1) });

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const raw = await request.json().catch(() => null);
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!campaign) return json({ error: 'not_found' }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.cronExpression !== undefined) {
    // Empty string normalizes to null (clear the schedule) rather than
    // persisting a blank cron_expression. Validate with the same library
    // the scheduler daemon uses, same rationale as POST /api/campaigns
    // (#234): the API is the real enforcement boundary, the UI is not.
    const trimmed = parsed.data.cronExpression?.trim() || null;
    if (trimmed) {
      const preview = previewCron(trimmed);
      if (!preview.valid) {
        return json({ error: 'invalid_cron', message: preview.error }, { status: 400 });
      }
      // Reseed next_run_at from the new schedule right away instead of
      // leaving the old schedule's stale value in place until the
      // scheduler's next tick - otherwise the campaign could fire once
      // more on the *previous* cron before the edit takes effect.
      patch.nextRunAt = preview.nextRuns[0] ?? null;
    } else {
      patch.nextRunAt = null;
    }
    patch.cronExpression = trimmed;
  }
  if (parsed.data.agentRunner !== undefined) patch.agentRunner = parsed.data.agentRunner;
  if (parsed.data.autoPost !== undefined) patch.autoPost = parsed.data.autoPost;

  if (parsed.data.config !== undefined) {
    // Scenarios without a registered structured schema (e.g. mastodon-*)
    // accept the config as-is instead of crashing on a missing schema - same
    // "accepted as-is" stance as getCampaignReadiness.
    const scenarioSchema = getSchema(campaign.skillSlug as ScenarioSlug);
    if (scenarioSchema) {
      const result = scenarioSchema.safeParse(parsed.data.config);
      if (!result.success) {
        return json({ error: 'invalid_config', issues: result.error.issues }, { status: 400 });
      }
      patch.config = result.data;
    } else {
      patch.config = parsed.data.config;
    }
  }

  if (parsed.data.status === 'active') {
    const cfg =
      patch.config !== undefined
        ? (patch.config as Record<string, unknown>)
        : (campaign.config as Record<string, unknown>);
    if (!cfg || Object.keys(cfg).length === 0) {
      return json({ error: 'cannot_activate_without_config' }, { status: 400 });
    }
  }

  if (Object.keys(patch).length === 0) return json({ ok: true });

  await db.update(schema.campaigns).set(patch).where(eq(schema.campaigns.id, id));
  return json({ ok: true });
}

export async function DELETE(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');

  const raw = await request.json().catch(() => null);
  const parsed = DeleteBody.safeParse(raw);
  if (!parsed.success) return json({ error: 'invalid_body' }, { status: 400 });

  try {
    await deleteCampaign(getDb(), id, parsed.data.confirmName);
  } catch (e) {
    if (e instanceof CampaignDeleteNameMismatchError) {
      return json({ error: 'name_mismatch' }, { status: 400 });
    }
    if (e instanceof CampaignDeleteRunInFlightError) {
      return json({ error: 'run_in_flight', runId: e.runId }, { status: 409 });
    }
    throw e;
  }
  return json({ ok: true });
}
