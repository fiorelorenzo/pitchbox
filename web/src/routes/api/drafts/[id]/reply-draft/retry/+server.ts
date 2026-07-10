import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { runReplyDrafting } from '$lib/server/runner.js';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');
  if (draft.parentMessageId == null) throw error(400, 'not a reply draft');
  try {
    const out = await runReplyDrafting(id, draft.parentMessageId);
    if (out.alreadyRunning)
      return json({ error: 'already_running', runId: out.runId }, { status: 409 });
    return json({ ok: true, runId: out.runId });
  } catch (e) {
    throw error(400, String((e as Error).message));
  }
}
