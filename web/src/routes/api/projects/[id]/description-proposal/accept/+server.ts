import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { acceptDescriptionProposal } from '@pitchbox/shared/project-description-refresh';

const Body = z.object({ proposedDescription: z.string() });

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Applies the currently-live description proposal (#434). `proposedDescription`
 * is re-verified against a freshly computed proposal server-side rather than
 * trusted as given - the source set can change between the diff being shown
 * and this call landing, and applying stale text would be exactly the silent
 * overwrite this feature exists to prevent.
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

  const result = await acceptDescriptionProposal(
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
