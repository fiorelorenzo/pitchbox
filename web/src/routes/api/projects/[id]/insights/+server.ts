import { json } from '@sveltejs/kit';
import { runProjectInsights } from '$lib/server/runner.js';

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST({ params }: { params: { id: string } }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  try {
    const out = await runProjectInsights(id);
    if (out.alreadyRunning) {
      return json({ error: 'already_running', runId: out.runId }, { status: 409 });
    }
    return json({ runId: out.runId }, { status: 201 });
  } catch (e) {
    return json(
      { error: 'dispatch_failed', message: String((e as Error).message) },
      { status: 500 },
    );
  }
}
