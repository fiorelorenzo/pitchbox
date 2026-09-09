import { describe, expect, it, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { refreshGithubSource } from '@pitchbox/shared/github-sources';
import {
  clearInstallationTokenCache,
  recordInstallation,
  type GithubAppEnv,
} from '@pitchbox/shared/github-app';

// The point of #390: a private repository is only readable with an
// installation token. What this file defends is that the token actually
// reaches the request, that it is not presented to an account that never
// granted it, and that the two 404s (invisible versus not selected) are told
// apart, because they have different fixes.

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const APP: GithubAppEnv = { appId: '4883602', slug: 'pitchbox-companion', privateKey: PEM };

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; auth: string | undefined };

function githubDouble(opts: { repoStatus?: number } = {}) {
  const calls: Call[] = [];
  const impl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.endsWith('/access_tokens')) {
      return jsonRes({
        token: 'ghs_installation',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url.endsWith('/readme')) {
      return jsonRes({
        encoding: 'base64',
        content: Buffer.from('# Private\n\nA repo.').toString('base64'),
      });
    }
    if (url.includes('/commits')) {
      return jsonRes([
        {
          sha: 'abc123',
          commit: {
            message: 'feat: something\n\nbody',
            committer: { date: '2026-09-01T00:00:00Z' },
          },
        },
      ]);
    }
    if (opts.repoStatus && opts.repoStatus !== 200) {
      return jsonRes({ message: 'Not Found' }, opts.repoStatus);
    }
    return jsonRes({ description: 'A private repo', language: 'TypeScript' });
  };
  return { impl, calls };
}

async function seedOrgAndSource(slug: string, owner: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [source] = await db
    .insert(schema.githubSources)
    .values({
      organizationId: org.id,
      owner,
      repo: 'private-thing',
      url: `https://github.com/${owner}/private-thing`,
    })
    .returning();
  return { orgId: org.id, sourceId: source.id };
}

describe('refreshGithubSource with a GitHub App installation', () => {
  beforeEach(async () => {
    clearInstallationTokenCache();
    const db = getDb();
    await db.execute(sql`TRUNCATE github_installations, github_sources RESTART IDENTITY CASCADE`);
    await db.execute(sql`DELETE FROM organizations WHERE slug LIKE 'ghsrc-%'`);
  });

  it('reads a private repository with the installation token on every call', async () => {
    const { orgId, sourceId } = await seedOrgAndSource('ghsrc-a', 'fiorelorenzo');
    await recordInstallation(getDb(), orgId, {
      installationId: 160289335,
      accountLogin: 'fiorelorenzo',
      accountType: 'User',
      repositorySelection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
    });

    const gh = githubDouble();
    await refreshGithubSource(getDb(), sourceId, { fetchImpl: gh.impl, app: APP });

    // The repo, README and commit calls all carry the token: a private repo
    // 404s on any one of them without it, so a half-authenticated refresh
    // would silently store metadata with no README.
    const repoCalls = gh.calls.filter((c) => !c.url.endsWith('/access_tokens'));
    expect(repoCalls).toHaveLength(3);
    for (const call of repoCalls) expect(call.auth).toBe('token ghs_installation');

    const [row] = await getDb()
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, sourceId));
    expect(row.description).toBe('A private repo');
    expect(row.readmeExcerpt).toContain('A repo.');
    expect(row.recentCommits).toEqual([
      { sha: 'abc123', message: 'feat: something', committedAt: '2026-09-01T00:00:00Z' },
    ]);
    expect(row.fetchError).toBeNull();
  });

  it('reads anonymously when the owner is not an account this org installed on', async () => {
    const { orgId, sourceId } = await seedOrgAndSource('ghsrc-b', 'someone-else');
    await recordInstallation(getDb(), orgId, {
      installationId: 160288218,
      accountLogin: 'fiorelorenzo',
      accountType: 'User',
      repositorySelection: 'selected',
      permissions: { contents: 'read' },
    });

    const gh = githubDouble();
    await refreshGithubSource(getDb(), sourceId, { fetchImpl: gh.impl, app: APP });

    expect(gh.calls.some((c) => c.url.endsWith('/access_tokens'))).toBe(false);
    for (const call of gh.calls) expect(call.auth).toBeUndefined();
  });

  it('says which 404 it is, because the two have different fixes', async () => {
    const anon = await seedOrgAndSource('ghsrc-c', 'stranger');
    const gh1 = githubDouble({ repoStatus: 404 });
    await refreshGithubSource(getDb(), anon.sourceId, { fetchImpl: gh1.impl, app: APP });
    const [anonRow] = await getDb()
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, anon.sourceId));
    expect(anonRow.fetchError).toMatch(/needs the GitHub App/);

    const auth = await seedOrgAndSource('ghsrc-d', 'fiorelorenzo');
    await recordInstallation(getDb(), auth.orgId, {
      installationId: 160289336,
      accountLogin: 'fiorelorenzo',
      accountType: 'User',
      repositorySelection: 'selected',
      permissions: { contents: 'read' },
    });
    const gh2 = githubDouble({ repoStatus: 404 });
    await refreshGithubSource(getDb(), auth.sourceId, { fetchImpl: gh2.impl, app: APP });
    const [authRow] = await getDb()
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, auth.sourceId));
    expect(authRow.fetchError).toMatch(/selected repositories/);
  });
});
