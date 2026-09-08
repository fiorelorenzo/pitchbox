import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { declineDescriptionProposal } from '@pitchbox/shared/project-description-refresh';

const Body = z.object({ proposedDescription: z.string() });

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Discards the currently-live description proposal (#434):
 * `projects.description` is never touched, and this exact text will not be
 * proposed again until the active source set changes - see
 * `declineDescriptionProposal` in shared/src/project-description-refresh.ts.
 */
export async function POST(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const result = await declineDescriptionProposal(
    getDb(),
    orgId,
    id,
    parsed.data.proposedDescription,
  );
  if (!result.ok) {
    const status = result.code === 'not_found' ? 404 : 409;
    return json({ ok: false, error: result.code }, { status });
  }
  return json({ ok: true });
}
