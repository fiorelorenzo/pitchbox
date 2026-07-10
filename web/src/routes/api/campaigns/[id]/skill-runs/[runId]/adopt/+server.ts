import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../../../../../../lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { campaignBelongsToOrg } from '@pitchbox/shared/orgs';

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Adopt the generated profile from a tuning run: copies
 * `run.params.generatedConfig` into `campaigns.config` and marks the run
 * `params.adopted = true`. The user pins the tuned skill body to the campaign.
 */
export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  const runId = parseId(params.runId);
  if (!id || !runId) return json({ error: 'invalid_id' }, { status: 400 });

  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const db = getDb();
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.campaignId, id)));
  if (!run) return json({ error: 'not_found' }, { status: 404 });
  if (run.kind !== 'campaign_skill_generation')
    return json({ error: 'wrong_kind' }, { status: 400 });
  if (run.status !== 'success') return json({ error: 'not_ready' }, { status: 409 });

  const rp = (run.params as Record<string, unknown> | null) ?? {};
  const generated = rp.generatedConfig as Record<string, unknown> | undefined;
  if (!generated) return json({ error: 'no_generated_config' }, { status: 422 });

  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!campaign) return json({ error: 'campaign_not_found' }, { status: 404 });

  await db.transaction(async (tx) => {
    const nextStatus = campaign.status === 'draft' ? 'active' : campaign.status;
    await tx
      .update(schema.campaigns)
      .set({ config: generated, status: nextStatus })
      .where(eq(schema.campaigns.id, id));
    await tx
      .update(schema.runs)
      .set({ params: { ...rp, adopted: true, discarded: false } })
      .where(eq(schema.runs.id, runId));
  });

  return json({ ok: true });
}
