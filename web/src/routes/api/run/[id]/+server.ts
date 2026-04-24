import { json, error } from '@sveltejs/kit';
import { cancelRun } from '$lib/server/runner.js';

export async function DELETE({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const cancelled = await cancelRun(id);
  if (!cancelled) throw error(404, 'run not running (already finished or unknown)');
  return json({ ok: true, runId: id });
}
