import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  clearInstallationTokenCache,
  deleteInstallation,
  fetchInstallation,
  forgetInstallation,
  getInstallationToken,
  installationTokenForOwner,
  installationUrl,
  listInstallations,
  loadGithubAppEnv,
  mintAppJwt,
  recordInstallation,
  type GithubAppEnv,
} from '@pitchbox/shared/github-app';

// The optional GitHub App (#390). What is worth defending here is not that the
// module can format a JWT, it is the three things that decide whether a
// private repository is read safely: a half-configured credential is refused
// rather than degraded, an installation cannot be claimed by a second
// organization, and a token is only ever presented to the account that
// granted it.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const APP: GithubAppEnv = { appId: '4883602', slug: 'pitchbox-companion', privateKey: PEM };

function envFor(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_APP_ID: '4883602',
    GITHUB_APP_SLUG: 'pitchbox-companion',
    GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(PEM).toString('base64'),
    ...overrides,
  };
}

/** A fetch double that records what it was called with, so a test can assert
 * on the Authorization header rather than on a return value. */
function fakeFetch(
  handler: (url: string, init?: { method?: string; headers?: Record<string, string> }) => Response,
) {
  const calls: Array<{ url: string; method: string; auth: string | undefined }> = [];
  const impl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    calls.push({ url, method: init?.method ?? 'GET', auth: init?.headers?.Authorization });
    return handler(url, init);
  };
  return { impl, calls };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('loadGithubAppEnv', () => {
  it('returns null when no app is configured, which is the self-host default', () => {
    expect(loadGithubAppEnv({})).toBeNull();
  });

  it('refuses a half-configured app instead of silently reading anonymously', () => {
    // The failure this prevents: with only two of the three set, a private
    // repository would be reported as "not found", the same string GitHub
    // returns for a repo that really is gone, and nobody would know the
    // credential was never used.
    expect(() => loadGithubAppEnv({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'x' })).toThrow(
      /GITHUB_APP_PRIVATE_KEY_B64 not set/,
    );
    expect(() => loadGithubAppEnv(envFor({ GITHUB_APP_SLUG: undefined }))).toThrow(
      /GITHUB_APP_SLUG not set/,
    );
  });

  it('refuses a key that is not a base64 PEM, naming how to encode one', () => {
    expect(() =>
      loadGithubAppEnv(envFor({ GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(PEM).toString('utf8') })),
    ).toThrow(/base64 -w0/);
  });

  it('refuses a non-numeric app id', () => {
    expect(() => loadGithubAppEnv(envFor({ GITHUB_APP_ID: 'pitchbox-companion' }))).toThrow(
      /must be numeric/,
    );
  });

  it('decodes the key so the app id and slug are usable', () => {
    const app = loadGithubAppEnv(envFor());
    expect(app?.appId).toBe('4883602');
    expect(app?.privateKey).toContain('-----BEGIN');
    expect(installationUrl(app!, 'st.ate')).toBe(
      'https://github.com/apps/pitchbox-companion/installations/new?state=st.ate',
    );
  });
});

describe('mintAppJwt', () => {
  it('signs a token GitHub will accept: RS256, backdated iat, exp inside ten minutes', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const [header, payload, signature] = mintAppJwt(APP, now).split('.');

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    const seconds = Math.floor(now.getTime() / 1000);
    expect(claims.iss).toBe('4883602');
    // Backdated, because GitHub refuses a token issued in the future when the
    // calling machine's clock runs fast.
    expect(claims.iat).toBeLessThan(seconds);
    // GitHub refuses an exp more than 600s out.
    expect(claims.exp - seconds).toBeLessThan(600);
    expect(claims.exp).toBeGreaterThan(seconds);
  });
});

describe('getInstallationToken', () => {
  beforeEach(clearInstallationTokenCache);
  afterEach(clearInstallationTokenCache);

  it('mints once and reuses the token until it is close to expiring', async () => {
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const f = fakeFetch(() => jsonRes({ token: 'ghs_first', expires_at: expires }));

    const a = await getInstallationToken(APP, 160289335, { fetchImpl: f.impl });
    const b = await getInstallationToken(APP, 160289335, { fetchImpl: f.impl });

    expect(a).toMatchObject({ ok: true, token: 'ghs_first' });
    expect(b).toMatchObject({ ok: true, token: 'ghs_first' });
    // One network call for two reads: minting is rate-limited, and a
    // suggestion can build a prompt from several sources at once.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].auth).toMatch(/^Bearer /);
  });

  it('refreshes rather than handing back a token about to expire mid-request', async () => {
    let n = 0;
    const f = fakeFetch(() =>
      jsonRes({
        token: `ghs_${++n}`,
        // Two minutes left, which is inside the refresh skew.
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      }),
    );
    await getInstallationToken(APP, 1, { fetchImpl: f.impl });
    const second = await getInstallationToken(APP, 1, { fetchImpl: f.impl });
    expect(second).toMatchObject({ token: 'ghs_2' });
  });

  it('reports an uninstalled app as such rather than throwing', async () => {
    const f = fakeFetch(() => jsonRes({ message: 'Not Found' }, 404));
    const res = await getInstallationToken(APP, 999, { fetchImpl: f.impl });
    expect(res).toMatchObject({ ok: false, status: 404 });
    expect(res.ok === false && res.reason).toMatch(/uninstalled on GitHub/);
  });
});

describe('fetchInstallation', () => {
  it('is what makes the setup callback trustworthy: an unknown installation is refused', async () => {
    // The attack this closes: `installation_id` arrives as a query parameter
    // on a GET, so anybody can put a stranger's id there. An id belonging to
    // another app answers 404 against our JWT.
    const f = fakeFetch(() => jsonRes({ message: 'Not Found' }, 404));
    const res = await fetchInstallation(APP, 160289335, { fetchImpl: f.impl });
    expect(res).toMatchObject({ ok: false, reason: 'no such installation for this app' });
  });

  it('reads the account and the repository selection GitHub reports', async () => {
    const f = fakeFetch(() =>
      jsonRes({
        id: 160289335,
        account: { login: 'fiorelorenzo', type: 'User' },
        repository_selection: 'selected',
        permissions: { contents: 'read', metadata: 'read' },
      }),
    );
    const res = await fetchInstallation(APP, 160289335, { fetchImpl: f.impl });
    expect(res.ok && res.details).toEqual({
      installationId: 160289335,
      accountLogin: 'fiorelorenzo',
      accountType: 'User',
      repositorySelection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
    });
  });
});

describe('installations in the database', () => {
  let orgA: number;
  let orgB: number;

  beforeEach(async () => {
    clearInstallationTokenCache();
    const db = getDb();
    await db.execute(sql`TRUNCATE github_installations RESTART IDENTITY CASCADE`);
    await db.execute(sql`DELETE FROM organizations WHERE slug LIKE 'ghapp-%'`);
    const [a] = await db
      .insert(schema.organizations)
      .values({ slug: 'ghapp-a', name: 'ghapp-a' })
      .returning();
    const [b] = await db
      .insert(schema.organizations)
      .values({ slug: 'ghapp-b', name: 'ghapp-b' })
      .returning();
    orgA = a.id;
    orgB = b.id;
  });

  const details = (overrides: Record<string, unknown> = {}) => ({
    installationId: 160289335,
    accountLogin: 'fiorelorenzo',
    accountType: 'User',
    repositorySelection: 'selected',
    permissions: { contents: 'read', metadata: 'read' },
    ...overrides,
  });

  it('refuses to let a second organization claim the same installation', async () => {
    // This is the cross-tenant hole the unique index exists for: an
    // installation is one GitHub account, so two orgs holding it would mean
    // the second reading the first's private repositories.
    expect(await recordInstallation(getDb(), orgA, details())).toMatchObject({ ok: true });
    expect(await recordInstallation(getDb(), orgB, details())).toEqual({
      ok: false,
      code: 'claimed_by_other_org',
    });
    expect(await listInstallations(getDb(), orgB)).toHaveLength(0);
  });

  it('refreshes an existing row when the account changes its selection', async () => {
    await recordInstallation(getDb(), orgA, details());
    await recordInstallation(getDb(), orgA, details({ repositorySelection: 'all' }));
    const rows = await listInstallations(getDb(), orgA);
    expect(rows).toHaveLength(1);
    expect(rows[0].repositorySelection).toBe('all');
  });

  it('scopes forgetting to the caller organization', async () => {
    await recordInstallation(getDb(), orgA, details());
    const [row] = await listInstallations(getDb(), orgA);
    // Another org's id is indistinguishable from a nonexistent one, which is
    // what lets the route answer 404 and never 403.
    expect(await forgetInstallation(getDb(), orgB, row.id)).toBeNull();
    expect(await forgetInstallation(getDb(), orgA, row.id)).toMatchObject({ id: row.id });
    expect(await listInstallations(getDb(), orgA)).toHaveLength(0);
  });

  it('presents a token only to the account that granted it', async () => {
    await recordInstallation(getDb(), orgA, details({ accountLogin: 'fiorelorenzo' }));
    const f = fakeFetch(() =>
      jsonRes({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    );

    // Case-insensitive, because GitHub compares logins that way.
    expect(
      await installationTokenForOwner(getDb(), orgA, 'FioreLorenzo', {
        app: APP,
        fetchImpl: f.impl,
      }),
    ).toMatchObject({ token: 'ghs_x', installationId: 160289335 });

    // A different account gets nothing rather than being handed this token:
    // presenting it there would only ever 404, and trying every installation
    // would burn the rate limit to learn that.
    expect(
      await installationTokenForOwner(getDb(), orgA, 'someone-else', {
        app: APP,
        fetchImpl: f.impl,
      }),
    ).toBeNull();

    // And another organization gets nothing at all.
    expect(
      await installationTokenForOwner(getDb(), orgB, 'fiorelorenzo', {
        app: APP,
        fetchImpl: f.impl,
      }),
    ).toBeNull();
  });

  it('reads anonymously when the deployment has no app', async () => {
    await recordInstallation(getDb(), orgA, details());
    expect(
      await installationTokenForOwner(getDb(), orgA, 'fiorelorenzo', { app: null }),
    ).toBeNull();
  });
});

describe('deleteInstallation', () => {
  it('treats an already-gone installation as success', async () => {
    const f = fakeFetch(() => new Response(null, { status: 404 }));
    expect(await deleteInstallation(APP, 1, { fetchImpl: f.impl })).toEqual({ ok: true });
    expect(f.calls[0].method).toBe('DELETE');
  });

  it('reports a refusal rather than claiming the app was uninstalled', async () => {
    const f = fakeFetch(() => new Response(null, { status: 500 }));
    expect(await deleteInstallation(APP, 1, { fetchImpl: f.impl })).toEqual({
      ok: false,
      reason: 'GitHub returned 500',
    });
  });
});
