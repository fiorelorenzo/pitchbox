import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { runProjectInsights } from '$lib/server/runner.js';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const [project] = await getDb()
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, id));
  if (!project) return json({ error: 'not_found' }, { status: 404 });
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
