import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import {
  ASSIST_COMMENT_CAP_CEILING,
  ASSIST_POST_CAP_CEILING,
  loadLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';

// GET + POST the caller's own org's LinkedIn assist settings (LI-19, #316):
// on/off, the bound project, the observation collector on/off, daily caps and
// the kill switch. Org-scoped via requireOrgId (never from the request body)
// and role-gated to admin, same level as Retention/Security
// (docs/permissions.md) - this is org structural config, not something a
// member should even view, unlike the platform-wide Quota page.

const Body = z.object({
  enabled: z.boolean(),
  projectId: z.number().int().positive().nullable(),
  collectorEnabled: z.boolean(),
  dailyCommentCap: z.number().int().min(0).max(ASSIST_COMMENT_CAP_CEILING),
  dailyPostCap: z.number().int().min(0).max(ASSIST_POST_CAP_CEILING),
  killSwitch: z.boolean(),
});

export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');
  const settings = await loadLinkedInAssistSettings(getDb(), orgId);
  return json(settings);
}

export async function POST(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const parsed = Body.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) {
    throw error(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const body = parsed.data;

  // A suggestion has to be written as some project's voice
  // (docs/linkedin-integration-design.md), so assist cannot go live unbound.
  if (body.enabled && body.projectId == null) {
    throw error(400, 'a project must be bound before assist can be enabled');
  }
  const db = getDb();
  if (body.projectId != null && !(await projectBelongsToOrg(db, body.projectId, orgId))) {
    throw error(400, 'project not found in this organization');
  }

  await saveLinkedInAssistSettings(db, orgId, body);
  return json(body);
}
