import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { installationUrl, loadGithubAppEnv } from '@pitchbox/shared/github-app';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { encodeInstallState } from '$lib/server/github-install-state.js';

// Where "Connect GitHub" in Settings -> Companion sends the operator (#390).
// A redirect rather than a link with the URL baked into the page, for two
// reasons: the app slug is a deployment secret's neighbour in `.env` and does
// not belong in a client bundle, and the `state` has to be minted per request
// so the callback can pin the install to the organization that started it.
//
// Admin-gated like the rest of Settings' structural configuration
// (docs/permissions.md): an installation grants the whole org read access to
// somebody's repositories, which is not a member-level decision.
export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const app = loadGithubAppEnv();
  if (!app) {
    // No app registered for this deployment, which is the ordinary self-host
    // case. 501 rather than 404: the route exists, the capability is not
    // configured, and the difference is what tells an operator to read
    // docs/platforms/linkedin.md instead of filing a bug.
    throw error(501, 'github_app_not_configured');
  }

  const userId = event.locals.user?.id ?? 0;
  throw redirect(302, installationUrl(app, encodeInstallState(orgId, userId)));
}
