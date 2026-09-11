// Exercises shared/src/project-source-sync.ts: the per-kind fetch dispatcher
// behind a project source's "re-sync" (#432). `git`, `website` (#472) and
// `mastodon_account`/`hackernews_author` (#437) each have a real fetcher,
// and `git` picks between two of them from the URL (the GitHub API for a
// GitHub URL, `git ls-remote` for any other host, which is what collapsing
// the old `git`/`github` pair into one kind left behind);
// `linkedin_company` (not implemented yet - #435) and `folder`/`upload`
// (paths a description run reads directly) must each come back
// with a human-readable fetch_error instead of throwing, so an unimplemented
// kind renders as a source you can add and see rather than a crash. The
// website/mastodon/hackernews cases here use a mocked fetchImpl (proving the
// dispatcher routes to the right refresher and reports ok/fetch_error
// correctly) rather than a served fixture - the caps/timeout/error-shape
// behaviour those refreshers own is already proven against real fixture
// servers in website-source.test.ts, mastodon-source.test.ts and
// hackernews-source.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { createProjectSource, getProjectSource } from '../src/project-sources.js';
import { syncProjectSource } from '../src/project-source-sync.js';
import type { GithubFetch } from '../src/github-sources.js';
import type { WebsiteFetch } from '../src/website-source.js';
import type { MastodonPublicFetch } from '../src/platforms/mastodon/client.js';
import type { MastodonAccount, MastodonStatus } from '../src/platforms/mastodon/types.js';
import type { HackernewsRawFetch } from '../src/hackernews-source.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function setupOrgAndProject() {
  const db = getDb();
  const slug = `project-source-sync-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

/** `crawlWebsite`'s `fetchCapped` reads `.text()` (there is no `.body`
 * stream on this fake), not `.json()` - a separate helper from
 * `fakeResponse` for that reason. */
function fakeHtmlResponse(status: number, html: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/html' }),
    body: null,
    text: async () => html,
  } as unknown as Response;
}

const REPO_JSON = { description: 'A test repo', language: 'TypeScript' };
const README_JSON = (markdown: string) => ({
  content: Buffer.from(markdown, 'utf8').toString('base64'),
  encoding: 'base64',
});

function successfulFetch(readme = 'What this project does.'): GithubFetch {
  return async (url: string) => {
    if (url.endsWith('/readme')) return fakeResponse(200, README_JSON(readme));
    return fakeResponse(200, REPO_JSON);
  };
}

describe('syncProjectSource: git', () => {
  it('a GitHub URL is read through the API, storing output and clearing fetch_error', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'git', {
      value: 'https://github.com/acme/widget',
    });
    const result = await syncProjectSource(db, orgId, created!.id, {
      fetchImpl: successfulFetch(),
    });
    expect(result?.ok).toBe(true);
    expect(result?.source.fetchError).toBeNull();
    expect(result?.source.fetchedAt).not.toBeNull();
    expect(result?.source.output).toMatchObject({
      description: 'A test repo',
      primaryLanguage: 'TypeScript',
      readmeExcerpt: 'What this project does.',
    });
  });

  it('reads the url a row migrated from the old github kind carries instead of value', async () => {
    // Migration 0018 wrote `{ owner, repo, url }` for the rows it built out
    // of `github_sources`, with no `value` at all, and `syncGithub` only
    // ever read `value`: every one of those rows failed its re-sync with
    // "not a github url". 0038 backfills `value`, and this covers the row
    // shape itself so the reader cannot regress to one key.
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'git', {
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
    const result = await syncProjectSource(db, orgId, created!.id, {
      fetchImpl: successfulFetch(),
    });
    expect(result?.ok).toBe(true);
    expect(result?.source.output).toMatchObject({ primaryLanguage: 'TypeScript' });
  });

  it('a 404 sets a fetch_error explaining the repo was not found, in words', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'git', {
      value: 'https://github.com/acme/missing',
    });
    const fetchImpl: GithubFetch = async () => fakeResponse(404, {});
    const result = await syncProjectSource(db, orgId, created!.id, { fetchImpl });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toMatch(/not found/i);
  });

  it('a non-GitHub host is proved reachable with ls-remote, never the GitHub API', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'git', {
      value: 'https://git.example.com/acme/widget.git',
    });
    const githubCalls: string[] = [];
    const result = await syncProjectSource(db, orgId, created!.id, {
      fetchImpl: async (url: string) => {
        githubCalls.push(url);
        return fakeResponse(200, REPO_JSON);
      },
      gitLsRemoteImpl: async () => ({ branches: ['main', 'next'] }),
    });
    expect(githubCalls).toEqual([]);
    expect(result?.ok).toBe(true);
    expect(result?.source.fetchError).toBeNull();
    expect(result?.source.output).toMatchObject({ branchCount: 2, branches: ['main', 'next'] });
  });

  it('an unreachable remote sets the git error as the fetch_error, not a throw', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'git', {
      value: 'https://git.example.com/acme/private.git',
    });
    const result = await syncProjectSource(db, orgId, created!.id, {
      gitLsRemoteImpl: async () => {
        throw new Error('git ls-remote failed (exit 128): Authentication failed');
      },
    });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toMatch(/Authentication failed/);
  });

  it('a value that is no kind of repository URL sets a fetch_error instead of throwing', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'git', {
      value: 'not a git url at all!!',
    });
    const result = await syncProjectSource(db, orgId, created!.id, {
      fetchImpl: successfulFetch(),
    });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toBeTruthy();
  });
});

describe('syncProjectSource: kinds with no fetcher yet', () => {
  it.each(['linkedin_company'] as const)(
    '%s sets a fetch_error naming the kind, not a crash',
    async (kind) => {
      const { orgId, projectId } = await setupOrgAndProject();
      const db = getDb();
      const created = await createProjectSource(db, orgId, projectId, kind, {
        value: 'https://example.com/whatever',
      });
      const result = await syncProjectSource(db, orgId, created!.id);
      expect(result?.ok).toBe(false);
      expect(result?.source.fetchError).toContain(kind);
      expect(result?.source.fetchedAt).not.toBeNull();
    },
  );
});

function fakeAccount(overrides: Partial<MastodonAccount> = {}): MastodonAccount {
  return {
    id: '9',
    username: 'alice',
    acct: 'alice',
    display_name: 'Alice',
    url: 'https://mastodon.example/@alice',
    note: '',
    bot: false,
    locked: false,
    fields: [],
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<MastodonStatus> = {}): MastodonStatus {
  return {
    id: '1',
    uri: 'https://mastodon.example/users/alice/statuses/1',
    url: 'https://mastodon.example/@alice/1',
    created_at: '2026-01-01T00:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    content: '<p>Hello world.</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    account: fakeAccount(),
    mentions: [],
    tags: [],
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    reblog: null,
    ...overrides,
  };
}

describe('syncProjectSource: website', () => {
  it('a successful fetch stores output and clears fetch_error', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'website', {
      url: 'https://example.com/',
    });
    const websiteFetchImpl: WebsiteFetch = async () =>
      fakeHtmlResponse(200, '<h1>Acme</h1><p>We make widgets.</p>');

    const result = await syncProjectSource(db, orgId, created!.id, { websiteFetchImpl });
    expect(result?.ok).toBe(true);
    expect(result?.source.fetchError).toBeNull();
    const output = result?.source.output as { text: string } | null;
    expect(output?.text).toContain('We make widgets.');
  });

  it('a network failure records fetch_error, never throwing', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'website', {
      url: 'https://example.com/',
    });
    const websiteFetchImpl: WebsiteFetch = async () => {
      throw new Error('connection refused');
    };

    const result = await syncProjectSource(db, orgId, created!.id, { websiteFetchImpl });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toMatch(/network error/);
  });
});

describe('syncProjectSource: mastodon_account', () => {
  it('a successful fetch stores output and clears fetch_error', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'mastodon_account', {
      instanceUrl: 'https://mastodon.example',
      acct: 'alice',
    });
    const account = fakeAccount();
    const statuses = [fakeStatus()];
    const mastodonFetchImpl: MastodonPublicFetch = async (url) =>
      url.includes('/lookup') ? fakeResponse(200, account) : fakeResponse(200, statuses);

    const result = await syncProjectSource(db, orgId, created!.id, { mastodonFetchImpl });
    expect(result?.ok).toBe(true);
    expect(result?.source.fetchError).toBeNull();
    const output = result?.source.output as { text: string } | null;
    expect(output?.text).toContain('Hello world.');
  });

  it('a 404 lookup (unknown handle) records fetch_error, never throwing', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'mastodon_account', {
      instanceUrl: 'https://mastodon.example',
      acct: 'ghost',
    });
    const mastodonFetchImpl: MastodonPublicFetch = async () => fakeResponse(404, {});

    const result = await syncProjectSource(db, orgId, created!.id, { mastodonFetchImpl });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toMatch(/404/);
  });
});

describe('syncProjectSource: hackernews_author', () => {
  it('a successful fetch stores output and clears fetch_error', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'hackernews_author', {
      username: 'pg',
    });
    const hackernewsFetchImpl: HackernewsRawFetch = async (url) => {
      if (url.includes('/user/')) return fakeResponse(200, { id: 'pg', submitted: [1] });
      return fakeResponse(200, { id: 1, type: 'story', by: 'pg', title: 'Ask HN: something' });
    };

    const result = await syncProjectSource(db, orgId, created!.id, { hackernewsFetchImpl });
    expect(result?.ok).toBe(true);
    expect(result?.source.fetchError).toBeNull();
    const output = result?.source.output as { text: string } | null;
    expect(output?.text).toContain('Ask HN: something');
  });

  it('a network failure records fetch_error, never throwing', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'hackernews_author', {
      username: 'pg',
    });
    const hackernewsFetchImpl: HackernewsRawFetch = async () => {
      throw new Error('connection refused');
    };

    const result = await syncProjectSource(db, orgId, created!.id, { hackernewsFetchImpl });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toMatch(/network error/);
  });
});

// #436, spike #435: linkedin_post/linkedin_profile have no fetcher either,
// but unlike website/linkedin_company that is permanent by design, not a
// gap - the only lawful fill is the extension's own content script
// (project-source-match.ts), never a server-side re-sync. A re-sync click
// on one of these two kinds can only flip an already-filled row back to
// pending, so the next real page visit fills it again.
describe('syncProjectSource: linkedin_post/linkedin_profile flip back to pending, never fetch', () => {
  it.each(['linkedin_post', 'linkedin_profile'] as const)(
    '%s: syncing a pristine pending row leaves it pending, with no error',
    async (kind) => {
      const { orgId, projectId } = await setupOrgAndProject();
      const db = getDb();
      const created = await createProjectSource(db, orgId, projectId, kind, {
        value: 'https://www.linkedin.com/whatever',
        identifier: 'whatever',
      });
      const result = await syncProjectSource(db, orgId, created!.id);
      expect(result?.ok).toBe(false);
      expect(result?.source.output).toBeNull();
      expect(result?.source.fetchedAt).toBeNull();
      expect(result?.source.fetchError).toBeNull();
    },
  );

  it.each(['linkedin_post', 'linkedin_profile'] as const)(
    '%s: syncing an already-filled row clears output/fetchedAt back to pending, not an error',
    async (kind) => {
      const { orgId, projectId } = await setupOrgAndProject();
      const db = getDb();
      const created = await createProjectSource(db, orgId, projectId, kind, {
        value: 'https://www.linkedin.com/whatever',
        identifier: 'whatever',
      });
      await getDb()
        .update(schema.projectSources)
        .set({ output: { text: 'captured earlier' }, fetchedAt: new Date() })
        .where(eq(schema.projectSources.id, created!.id));

      const result = await syncProjectSource(db, orgId, created!.id);
      expect(result?.ok).toBe(false);
      expect(result?.source.output).toBeNull();
      expect(result?.source.fetchedAt).toBeNull();
      expect(result?.source.fetchError).toBeNull();
    },
  );
});

describe('syncProjectSource: path kinds have nothing to re-fetch', () => {
  it.each(['folder', 'upload'] as const)(
    '%s says it is read again by the next description run, rather than failing',
    async (kind) => {
      const { orgId, projectId } = await setupOrgAndProject();
      const db = getDb();
      const created = await createProjectSource(db, orgId, projectId, kind, { value: '/tmp/x' });
      const result = await syncProjectSource(db, orgId, created!.id);
      expect(result?.ok).toBe(false);
      expect(result?.source.fetchError).toMatch(/regenerated/i);
    },
  );
});

describe('syncProjectSource: organization scoping', () => {
  it('returns null for a source belonging to a different organization', async () => {
    const { orgId: ownerOrgId, projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, ownerOrgId, projectId, 'git', {
      value: 'https://github.com/acme/widget',
    });
    const result = await syncProjectSource(db, otherOrgId, created!.id);
    expect(result).toBeNull();
    // Nothing about the row moved - a probe from the wrong org learns nothing.
    const reloaded = await getProjectSource(db, ownerOrgId, created!.id);
    expect(reloaded?.fetchedAt).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    const { orgId } = await setupOrgAndProject();
    const result = await syncProjectSource(getDb(), orgId, 9_999_999);
    expect(result).toBeNull();
  });
});
