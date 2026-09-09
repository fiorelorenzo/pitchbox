import { error, json, type RequestEvent } from '@sveltejs/kit';
import {
  deleteInstallation,
  forgetInstallation,
  loadGithubAppEnv,
} from '@pitchbox/shared/github-app';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';

// Disconnecting an installation (#390). Two things happen, in this order:
// the row goes first, so the org stops using the credential even if GitHub is
// unreachable, and then the app is uninstalled from the account so its GitHub
// settings do not keep listing an app nothing reads.
//
// A GitHub failure on the second step is reported and not rolled back: the
// operator asked to stop using it, and leaving our row behind because GitHub
// timed out would be the wrong half to keep. The response says so, so he can
// finish the uninstall by hand.
//
// An id that does not exist, or belongs to another organization, is a 404 and
// never a 403 - the same rule `removeGithubSource` follows, so a probe against
// another org's id learns nothing.
export async function DELETE(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const id = Number(event.params.id);
  if (!Number.isInteger(id)) throw error(400, 'invalid id');

  const row = await forgetInstallation(getDb(), orgId, id);
  if (!row) throw error(404, 'not_found');

  const app = loadGithubAppEnv();
  if (!app) return json({ ok: true, uninstalled: false, reason: 'github_app_not_configured' });

  const removed = await deleteInstallation(app, row.installationId);
  return json({ ok: true, uninstalled: removed.ok, reason: removed.reason ?? null });
}
