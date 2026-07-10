import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { asc, eq } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import { runBelongsToOrg } from '@pitchbox/shared/orgs';

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await runBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const [run, events] = await Promise.all([
    db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: schema.runEvents.id,
        seq: schema.runEvents.seq,
        kind: schema.runEvents.kind,
        payload: schema.runEvents.payload,
        ts: schema.runEvents.createdAt,
      })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, id))
      .orderBy(asc(schema.runEvents.seq), asc(schema.runEvents.id))
      .limit(5000),
  ]);
  return json({ runId: id, run, events });
}
