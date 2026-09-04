import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { listProjects } from '@pitchbox/shared/projects';
import {
  ASSIST_COMMENT_CAP_CEILING,
  ASSIST_POST_CAP_CEILING,
  loadLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';

// LinkedIn assist settings (LI-19, #316): the off switch and owner for the
// in-page assistant. This is org structural config in the same class as
// Retention/Security (docs/permissions.md) - not something a member should
// even view, unlike the platform-wide Quota page - so the loader throws
// requireRole('admin') rather than narrowing the payload. The rail
// (settings/+layout.svelte) hides this link from a non-admin for the same
// reason it hides retention/security.
export const load: PageServerLoad = async (event) => {
  requireRole(event, 'admin');
  const orgId = await requireOrgId(event);
  const db = getDb();
  const [settings, projects] = await Promise.all([
    loadLinkedInAssistSettings(db, orgId),
    listProjects(db, { organizationId: orgId }),
  ]);
  return {
    settings,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    ceilings: { comment: ASSIST_COMMENT_CAP_CEILING, post: ASSIST_POST_CAP_CEILING },
  };
};
