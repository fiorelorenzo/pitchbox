import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { runProjectExtraction } from '$lib/server/runner.js';
import { requireOrgId, requireVerifiedEmail } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Starts a description run. It takes no body: the run reads the project's
 * whole active source set, so there is nothing left to choose here. It used
 * to require one `{ kind, value }` source, which is what made adding a
 * source and then describing the project two unrelated gestures.
 */
export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  await requireVerifiedEmail(event);
  try {
    const out = await runProjectExtraction(id);
    if (out.noSources) return json({ error: 'no_sources' }, { status: 400 });
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

export async function GET(event: RequestEvent) {
  const { params, url } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '5'), 1), 50);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, id), eq(schema.runs.kind, 'project_extraction')))
    .orderBy(desc(schema.runs.startedAt))
    .limit(limit);
  return json({ runs: rows });
}
