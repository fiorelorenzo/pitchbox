import { json, type RequestEvent } from '@sveltejs/kit';
import { listInstallations, loadGithubAppEnv } from '@pitchbox/shared/github-app';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';

// What Settings -> Companion renders for the GitHub App (#390). Member-level
// read, matching the other read-only settings lists (docs/permissions.md);
// the mutations (install, disconnect) are admin-gated in their own routes.
//
// `configured` is the deployment's own state, not the org's: it says whether
// this install has an app at all, which is what decides between offering a
// Connect button and explaining that a self-host needs no credential for
// public repositories. The app id and the slug are safe to expose (both are
// public halves of the registration, readable on the app's GitHub page); the
// private key never leaves the server, and is not read here.
export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const app = loadGithubAppEnv();
  const installations = app ? await listInstallations(getDb(), orgId) : [];

  return json({
    configured: Boolean(app),
    slug: app?.slug ?? null,
    installations: installations.map((row) => ({
      id: row.id,
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      permissions: row.permissions,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}
