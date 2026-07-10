import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { cancelRun } from '$lib/server/runner.js';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { runBelongsToOrg } from '@pitchbox/shared/orgs';

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await runBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const cancelled = await cancelRun(id);
  if (!cancelled) throw error(404, 'run not running (already finished or unknown)');
  return json({ ok: true, runId: id });
}
