import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../../../lib/server/db.js';
import { updateDraftWithVersion } from '../../../../lib/server/draft-state.js';
import { emit } from '../../../../lib/server/events.js';
import { requireOrgId } from '$lib/server/auth.js';

// Bulk reschedule: set `scheduled_send_after` so a batch of drafts is held back
// from "ready to send" until the chosen timestamp. Only meaningful while the
// drafts are still pre-`sent`.
type BulkBody = { ids?: unknown; send_after?: unknown };

const RESCHEDULABLE_STATES = new Set(['proposed', 'pending_review', 'approved']);

export async function POST(event: RequestEvent) {
  const { request } = event;
  const payload = (await request.json().catch(() => null)) as BulkBody | null;
  if (!payload || !Array.isArray(payload.ids) || payload.ids.length === 0) {
    throw error(400, 'ids is required');
  }
  if (typeof payload.send_after !== 'string') {
    throw error(400, 'send_after is required');
  }
  const when = new Date(payload.send_after);
  if (Number.isNaN(when.getTime())) {
    throw error(400, 'send_after must be a valid ISO datetime');
  }
  const ids = payload.ids
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw error(400, 'no valid ids');

  const orgId = await requireOrgId(event);
  const db = getDb();
  const drafts = await db
    .select()
    .from(schema.drafts)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
    .where(and(inArray(schema.drafts.id, ids), eq(schema.projects.organizationId, orgId)));
  const byId = new Map(drafts.map((row) => [row.drafts.id, row.drafts]));

  const results: Array<{ id: number; status: 'ok' | 'skipped'; reason?: string }> = [];

  for (const id of ids) {
    const draft = byId.get(id);
    if (!draft) {
      results.push({ id, status: 'skipped', reason: 'not_found' });
      continue;
    }
    if (!RESCHEDULABLE_STATES.has(draft.state)) {
      results.push({ id, status: 'skipped', reason: `state:${draft.state}` });
      continue;
    }
    const res = await updateDraftWithVersion(id, draft.version, {
      scheduledSendAfter: when,
    });
    if (res.kind === 'conflict') {
      results.push({ id, status: 'skipped', reason: 'version_conflict' });
      continue;
    }
    await db.insert(schema.draftEvents).values({
      draftId: id,
      event: 'rescheduled',
      actor: 'user',
      details: { sendAfter: when.toISOString(), bulk: true },
    });
    emit('drafts:changed', { id, state: draft.state }, orgId);
    results.push({ id, status: 'ok' });
  }

  return json({ results });
}
