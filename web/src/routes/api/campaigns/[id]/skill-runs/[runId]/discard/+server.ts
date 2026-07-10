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
 * Discard a tuning run - sets `run.params.discarded = true`. The campaign's
 * current config is left untouched. The run row is preserved for audit.
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

  const rp = (run.params as Record<string, unknown> | null) ?? {};
  await db
    .update(schema.runs)
    .set({ params: { ...rp, discarded: true, adopted: false } })
    .where(eq(schema.runs.id, runId));

  return json({ ok: true });
}
