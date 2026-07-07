import { json, error } from '@sveltejs/kit';
import { runDraftRegeneration } from '../../../../../lib/server/runner.js';

type Body = { hint?: unknown };

// Dispatch a real regeneration run (async). The draft flips to "regenerating"
// immediately (drafts:changed), and the rewritten body arrives over SSE when the
// run finishes.
export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');

  const payload = (await request.json().catch(() => ({}))) as Body;
  const hint =
    typeof payload.hint === 'string' && payload.hint.trim().length > 0 ? payload.hint : null;

  try {
    const out = await runDraftRegeneration(id, hint);
    if (out.alreadyRunning) {
      return json({ error: 'already_running', runId: out.runId }, { status: 409 });
    }
    return json({ ok: true, runId: out.runId });
  } catch (e) {
    throw error(400, String((e as Error).message));
  }
}
