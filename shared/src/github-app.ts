/**
 * The optional GitHub App (issue #390), which is what lets the companion read
 * a **private** repository. Without it `github-sources.ts` calls GitHub's
 * anonymous REST API: public repos only, 60 requests/hour per IP.
 *
 * Deliberately an App and not a PAT or a CLI login. A user token is scoped to
 * a person, expires in days, and refreshes only on the machine that minted it,
 * which is the failure mode written down in the store-publishing runbook: a
 * build that is green today and opaquely red next week. An App's credential is
 * a private key that signs a short-lived JWT, which buys an installation token
 * that expires in an hour and carries only the permissions and repositories
 * the installing account chose.
 *
 * The credential is a **deployment secret**, read from the environment the
 * same way `AI_GATEWAY_API_KEY` and the mail transport are
 * (`shared/src/mail/env.ts` explains why `app_config` is the wrong home for
 * one): never persisted to the database, never served to a client, never shown
 * on a Settings page. What lives in the database is only the public half: the
 * installation id and which account it belongs to.
 *
 * Two apps exist, one per deployment, because the setup URL GitHub redirects
 * to after an install is a property of the app registration:
 *   prod     Pitchbox Companion            app id 4883602
 *   preview  Pitchbox Companion (preview)  app id 4883544
 * Both ask for `contents: read` and `metadata: read` and nothing else, and
 * both have their webhook and their user-authorization flow switched off:
 * this feature reads repositories on demand and has no reason to receive
 * events or to act as the person who installed it.
 */

import { createSign } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type GithubAppEnv = {
  appId: string;
  /** The `pitchbox-companion` half of `https://github.com/apps/<slug>`, which
   * is the only way to build an installation URL. */
  slug: string;
  /** PEM, decoded from `GITHUB_APP_PRIVATE_KEY_B64`. */
  privateKey: string;
};

/**
 * The private key is carried base64-encoded because a PEM's newlines do not
 * survive an env file, a compose `environment:` list or a systemd unit. There
 * is deliberately no raw-PEM fallback variable: two ways to supply one
 * credential is how you end up with a deployment that holds a mangled key and
 * only finds out when it signs.
 *
 * The name is a literal in the lookup below rather than read through this
 * constant, and that is deliberate: `tests/docker-mail-env.test.ts` finds the
 * variables a loader reads by scanning it for direct property reads off its
 * `env` argument, so an indirect subscript would slip past the guard that
 * proves the compose files pass the variable through. This constant is only
 * used in the error messages.
 */
const PRIVATE_KEY_VAR = 'GITHUB_APP_PRIVATE_KEY_B64';

/**
 * Reads the app credential, or `null` when this deployment has no app - which
 * is the ordinary case for a self-host and stays fully supported: public repos
 * by URL, anonymously, exactly as before.
 *
 * A **partial** configuration throws instead of falling back. The mail
 * transport takes the opposite route (warn and degrade to the null transport)
 * because a deployment with no mail still works; here a half-set app is
 * unambiguous operator error, and degrading silently would present private
 * repositories as "not found" - the same string GitHub returns for a repo that
 * really is gone. Failing at load is the only way that mistake is visible.
 */
export function loadGithubAppEnv(
  env: Record<string, string | undefined> = process.env,
): GithubAppEnv | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const keyB64 = env.GITHUB_APP_PRIVATE_KEY_B64?.trim();

  const present = [appId, slug, keyB64].filter(Boolean).length;
  if (present === 0) return null;
  if (present < 3) {
    const missing = [
      appId ? null : 'GITHUB_APP_ID',
      slug ? null : 'GITHUB_APP_SLUG',
      keyB64 ? null : PRIVATE_KEY_VAR,
    ].filter(Boolean);
    throw new Error(
      `[github-app] partially configured: ${missing.join(', ')} not set. Set all three or none.`,
    );
  }
  if (!/^[0-9]+$/.test(appId!)) {
    throw new Error(`[github-app] GITHUB_APP_ID must be numeric, got "${appId}"`);
  }

  const privateKey = Buffer.from(keyB64!, 'base64').toString('utf8');
  if (!privateKey.includes('-----BEGIN') || !privateKey.includes('PRIVATE KEY-----')) {
    throw new Error(
      `[github-app] ${PRIVATE_KEY_VAR} did not decode to a PEM private key. It must be the .pem file base64-encoded, for example: base64 -w0 github-app.pem`,
    );
  }

  return { appId: appId!, slug: slug!, privateKey };
}

/** GitHub rejects a JWT whose `exp` is more than 10 minutes out. Nine leaves
 * room for clock skew in both directions without ever being refused. */
const JWT_TTL_SECONDS = 9 * 60;
/** GitHub's own advice for a fast clock on the calling machine: backdate
 * `iat`, or the token is "issued in the future" and refused. */
const JWT_BACKDATE_SECONDS = 30;

const b64url = (input: string | Buffer): string =>
  (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');

/**
 * A short-lived JWT identifying the **app** (not an installation). It can read
 * `/app` and mint installation tokens, and it can read no repository content
 * at all, so it is never the credential a fetch uses.
 */
export function mintAppJwt(app: GithubAppEnv, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat, exp: iat + JWT_TTL_SECONDS + JWT_BACKDATE_SECONDS, iss: app.appId }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(app.privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** Same narrow shape `github-sources.ts` uses, for the same reason: a test
 * double that only accepts a string URL is a valid substitute, while
 * `typeof fetch` would demand the `Request`/`URL` overloads this code never
 * calls. POST is needed here, so the init carries a method. */
export type GithubFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

const GITHUB_API_BASE = 'https://api.github.com';
const API_HEADERS = { Accept: 'application/vnd.github+json' };

export type InstallationTokenResult =
  { ok: true; token: string; expiresAt: Date } | { ok: false; reason: string; status?: number };

/**
 * Installation tokens last an hour and GitHub rate-limits minting them, so
 * they are cached in process and reused. Refreshed early (`SKEW_MS` before
 * expiry) so a token never expires mid-request. The cache is keyed by app id
 * as well as installation id: preview and prod are different apps, and a
 * process only ever holds one, but keying on both means a test that swaps the
 * app env is not served a stale token.
 */
const tokenCache = new Map<string, { token: string; expiresAt: Date }>();
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Test seam. Nothing in production calls this. */
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

export async function getInstallationToken(
  app: GithubAppEnv,
  installationId: number,
  opts: { fetchImpl?: GithubFetch; now?: Date } = {},
): Promise<InstallationTokenResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as GithubFetch);
  const now = opts.now ?? new Date();
  const key = `${app.appId}:${installationId}`;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_SKEW_MS) {
    return { ok: true, token: cached.token, expiresAt: cached.expiresAt };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...API_HEADERS, Authorization: `Bearer ${mintAppJwt(app, now)}` },
    });
  } catch (err) {
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  }

  if (!res.ok) {
    // 404 here means the installation is gone: somebody uninstalled the app
    // from the account. That is a normal end of life for a row, not an error
    // worth throwing - the caller drops back to anonymous reads.
    tokenCache.delete(key);
    return {
      ok: false,
      status: res.status,
      reason:
        res.status === 404
          ? 'installation no longer exists (uninstalled on GitHub)'
          : `GitHub refused to mint an installation token (${res.status})`,
    };
  }

  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) {
    return { ok: false, reason: 'GitHub returned a token response with no token' };
  }
  const expiresAt = new Date(body.expires_at);
  tokenCache.set(key, { token: body.token, expiresAt });
  return { ok: true, token: body.token, expiresAt };
}

export type InstallationDetails = {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
};

/**
 * Reads an installation from GitHub with the app JWT. This is what makes the
 * setup callback trustworthy: the `installation_id` in that redirect is a
 * query parameter anybody can forge, so it is never stored on the strength of
 * the request. An installation belonging to a different app answers 404 here.
 */
export async function fetchInstallation(
  app: GithubAppEnv,
  installationId: number,
  opts: { fetchImpl?: GithubFetch; now?: Date } = {},
): Promise<{ ok: true; details: InstallationDetails } | { ok: false; reason: string }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as GithubFetch);
  let res: Response;
  try {
    res = await fetchImpl(`${GITHUB_API_BASE}/app/installations/${installationId}`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${mintAppJwt(app, opts.now)}` },
    });
  } catch (err) {
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason:
        res.status === 404
          ? 'no such installation for this app'
          : `GitHub returned ${res.status} for that installation`,
    };
  }
  const body = (await res.json()) as {
    id?: number;
    account?: { login?: string; type?: string };
    repository_selection?: string;
    permissions?: Record<string, string>;
  };
  if (!body.id || !body.account?.login) {
    return { ok: false, reason: 'GitHub returned an installation with no account' };
  }
  return {
    ok: true,
    details: {
      installationId: body.id,
      accountLogin: body.account.login,
      accountType: body.account.type ?? 'User',
      repositorySelection: body.repository_selection ?? 'selected',
      permissions: body.permissions ?? {},
    },
  };
}

/** Uninstalls the app from the account. Called when an operator disconnects an
 * installation here, so the account's GitHub settings do not keep listing an
 * app nothing uses. A 404 is success: it is already gone. */
export async function deleteInstallation(
  app: GithubAppEnv,
  installationId: number,
  opts: { fetchImpl?: GithubFetch; now?: Date } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as GithubFetch);
  try {
    const res = await fetchImpl(`${GITHUB_API_BASE}/app/installations/${installationId}`, {
      method: 'DELETE',
      headers: { ...API_HEADERS, Authorization: `Bearer ${mintAppJwt(app, opts.now)}` },
    });
    clearInstallationTokenCache();
    if (res.ok || res.status === 404) return { ok: true };
    return { ok: false, reason: `GitHub returned ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  }
}

export type GithubInstallationRow = typeof schema.githubInstallations.$inferSelect;

/** Every installation an organization has connected, oldest first. An org may
 * hold more than one: a person's own account and an organization account are
 * separate installations, and a source can live under either. */
export async function listInstallations(
  db: Db,
  organizationId: number,
): Promise<GithubInstallationRow[]> {
  return db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.organizationId, organizationId))
    .orderBy(schema.githubInstallations.id);
}

/**
 * Records (or refreshes) an installation for an organization. Keyed on the
 * installation id alone, not on `(org, installation)`: an installation belongs
 * to exactly one GitHub account, and letting two organizations claim the same
 * one would let a second tenant read the first tenant's private repositories.
 * A re-install onto an account that a different org already holds is therefore
 * a refusal, not an upsert.
 */
export async function recordInstallation(
  db: Db,
  organizationId: number,
  details: InstallationDetails,
): Promise<{ ok: true; row: GithubInstallationRow } | { ok: false; code: 'claimed_by_other_org' }> {
  const [existing] = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.installationId, details.installationId));

  if (existing && existing.organizationId !== organizationId) {
    return { ok: false, code: 'claimed_by_other_org' };
  }

  const values = {
    organizationId,
    installationId: details.installationId,
    accountLogin: details.accountLogin,
    accountType: details.accountType,
    repositorySelection: details.repositorySelection,
    permissions: details.permissions,
    updatedAt: new Date(),
  };

  if (existing) {
    const [row] = await db
      .update(schema.githubInstallations)
      .set(values)
      .where(eq(schema.githubInstallations.id, existing.id))
      .returning();
    return { ok: true, row };
  }

  const [row] = await db.insert(schema.githubInstallations).values(values).returning();
  return { ok: true, row };
}

/** Forgets an installation, scoped to the caller's organization. Returns false
 * when the id does not exist or belongs to another org, which the caller turns
 * into a 404 and never a 403, so a probe learns nothing - the same rule
 * `removeGithubSource` follows. */
export async function forgetInstallation(
  db: Db,
  organizationId: number,
  id: number,
): Promise<GithubInstallationRow | null> {
  const [row] = await db
    .delete(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, id),
        eq(schema.githubInstallations.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The credential a read of `owner/repo` should use, or `null` for "read it
 * anonymously, as before".
 *
 * Resolution is by **account login**, because that is what an installation
 * actually is: the account installs the app, and the repositories it exposes
 * all belong to that account. Matching case-insensitively, since GitHub logins
 * are compared that way. When an org has no installation for that owner the
 * answer is `null` rather than "try them all": presenting one account's token
 * on another account's repository would only ever produce a 404, and trying
 * every installation would burn the rate limit to learn that.
 */
export async function installationTokenForOwner(
  db: Db,
  organizationId: number,
  owner: string,
  opts: { app?: GithubAppEnv | null; fetchImpl?: GithubFetch; now?: Date } = {},
): Promise<{ token: string; installationId: number } | null> {
  const app = opts.app === undefined ? loadGithubAppEnv() : opts.app;
  if (!app) return null;

  const rows = await listInstallations(db, organizationId);
  const match = rows.find((r) => r.accountLogin.toLowerCase() === owner.toLowerCase());
  if (!match) return null;

  const token = await getInstallationToken(app, match.installationId, opts);
  if (!token.ok) {
    console.warn(
      `[github-app] installation ${match.installationId} (${match.accountLogin}): ${token.reason}`,
    );
    return null;
  }
  return { token: token.token, installationId: match.installationId };
}

/**
 * Where GitHub sends somebody to install the app. `state` is ours and comes
 * back on the setup redirect, which is how the callback knows which
 * organization asked - see `web/src/lib/server/github-install-state.ts`.
 */
export function installationUrl(app: GithubAppEnv, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}
