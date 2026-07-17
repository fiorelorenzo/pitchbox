import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getSchema, type ScenarioSlug } from '@pitchbox/shared/campaigns';
import { requireOrgId } from '$lib/server/auth.js';
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
  if (parsed.data.cronExpression !== undefined) patch.cronExpression = parsed.data.cronExpression;
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
