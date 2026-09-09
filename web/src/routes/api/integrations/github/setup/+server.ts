import { redirect, type RequestEvent } from '@sveltejs/kit';
import {
  fetchInstallation,
  loadGithubAppEnv,
  recordInstallation,
} from '@pitchbox/shared/github-app';
import { getDb } from '$lib/server/db.js';
import { resolveOrgId, requireRole } from '$lib/server/auth.js';
import { decodeInstallState } from '$lib/server/github-install-state.js';

// The GitHub App's setup URL (#390): where GitHub sends the browser after
// somebody installs or updates the app. Registered on both apps as
// `https://<host>/api/integrations/github/setup` with "redirect on update"
// on, so a repository-selection change also lands here and refreshes the row.
//
// Everything in this request is attacker-supplied, so nothing is believed:
//
//   - `installation_id` is read back from GitHub with the app JWT. An id that
//     belongs to another app, or to nothing, answers 404 there and is refused.
//     That is what stops somebody pasting a stranger's installation id into
//     this URL and attaching it to their own organization.
//   - `state` is HMAC-signed by us and pins the organization that started the
//     flow (see github-install-state.ts).
//   - The session still has to exist and still has to be an admin of that
//     organization. A signed state is not an authentication.
//
// This is a browser redirect target, not an API: it never returns JSON, it
// always lands the operator back on the page he started from with a result in
// the query string, so a failure is something he can read rather than a
// stack trace.
const BACK = '/settings/companion';

function back(result: string, detail?: string): never {
  const params = new URLSearchParams({ github: result });
  if (detail) params.set('detail', detail);
  throw redirect(303, `${BACK}?${params.toString()}`);
}

export async function GET(event: RequestEvent) {
  const url = event.url;
  const setupAction = url.searchParams.get('setup_action');
  const installationIdRaw = url.searchParams.get('installation_id');

  const app = loadGithubAppEnv();
  if (!app) back('not_configured');

  // GitHub sends `setup_action=request` when somebody without permission on
  // the account asked an owner to approve the install. Nothing exists yet, so
  // there is nothing to store and saying so is the whole job.
  if (setupAction === 'request') back('requested');

  const installationId = Number(installationIdRaw);
  if (!Number.isInteger(installationId) || installationId <= 0) back('bad_request');

  const state = decodeInstallState(url.searchParams.get('state'));
  if (!state.ok) {
    // An install started from GitHub's own directory rather than from
    // Settings carries no state at all. That is a real path, not an attack,
    // and the honest answer is to tell the operator to start it from the app
    // rather than to guess which organization he meant.
    back('no_state', state.reason);
  }

  const sessionOrgId = await resolveOrgId(event);
  if (sessionOrgId == null) back('unauthenticated');
  if (sessionOrgId !== state.orgId) back('wrong_org');
  try {
    requireRole(event, 'admin');
  } catch {
    back('forbidden');
  }

  const details = await fetchInstallation(app, installationId);
  if (!details.ok) back('unverified', details.reason);

  const recorded = await recordInstallation(getDb(), state.orgId, details.details);
  if (!recorded.ok) back('claimed_by_other_org');

  back('installed', details.details.accountLogin);
}
