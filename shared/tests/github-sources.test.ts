// Exercises shared/src/github-sources.ts: the anonymous-GitHub cache behind
// the companion's "what you have shipped" knowledge (Lorenzo's decision,
// 2026-09-07 - public repos by URL, no credential). Covers URL parsing, the
// three failure shapes that actually happen (404 / rate-limited 403 /
// network error), the TTL that keeps refreshes inside GitHub's anonymous
// 60/hour ceiling, README badge stripping, and organization scoping.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import type { GithubFetch } from '../src/github-sources.js';
import {
  addGithubSource,
  listGithubSources,
  parseRepoUrl,
  refreshGithubSource,
  refreshStaleGithubSources,
  removeGithubSource,
} from '../src/github-sources.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    // Cascades to github_sources (onDelete: 'cascade' in schema.ts).
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function setupOrg() {
  const db = getDb();
  const slug = `github-sources-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

/** Minimal fetch-shaped stand-in. `headers` accepts a plain object because
 * that is all the code under test ever reads from it (`.get(name)`). */
function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const REPO_JSON = { description: 'A test repo', language: 'TypeScript' };
const README_JSON = (markdown: string) => ({
  content: Buffer.from(markdown, 'utf8').toString('base64'),
  encoding: 'base64',
});

/** A fetchImpl that answers repo/readme/commits with fixed, successful bodies. */
function successfulFetch(readme = 'Just some prose.') {
  return async (url: string) => {
    if (url.endsWith('/readme')) return fakeResponse(200, README_JSON(readme));
    if (url.includes('/commits')) {
      return fakeResponse(200, [
        {
          sha: 'abc123',
          commit: {
            message: 'fix: thing\n\nlonger body',
            committer: { date: '2026-09-01T00:00:00Z' },
          },
        },
      ]);
    }
    return fakeResponse(200, REPO_JSON);
  };
}

describe('parseRepoUrl', () => {
  it('accepts a plain https URL', () => {
    const r = parseRepoUrl('https://github.com/acme/widget');
    expect(r).toEqual({
      ok: true,
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
  });

  it('accepts a .git suffix', () => {
    const r = parseRepoUrl('https://github.com/acme/widget.git');
    expect(r).toEqual({
      ok: true,
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
  });

  it('accepts a trailing slash', () => {
    const r = parseRepoUrl('https://github.com/acme/widget/');
    expect(r).toEqual({
      ok: true,
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
  });

  it('accepts a deep path', () => {
    const r = parseRepoUrl('https://github.com/acme/widget/tree/main/src');
    expect(r).toEqual({
      ok: true,
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
  });

  it('accepts owner/repo shorthand', () => {
    const r = parseRepoUrl('acme/widget');
    expect(r).toEqual({
      ok: true,
      owner: 'acme',
      repo: 'widget',
      url: 'https://github.com/acme/widget',
    });
  });

  it('rejects a non-GitHub host explicitly, not by guessing', () => {
    const r = parseRepoUrl('https://gitlab.com/acme/widget');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('gitlab.com');
    expect(r.reason).toContain('not github.com');
  });

  it('rejects an unparseable string with a reason instead of throwing', () => {
    const r = parseRepoUrl('not a url at all');
    expect(r.ok).toBe(false);
  });
});

describe('refreshGithubSource', () => {
  it('stores a distinct fetch_error on 404 and leaves the row usable', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'gone',
        url: 'https://github.com/acme/gone',
        description: 'previously fetched description',
      })
      .returning();

    await refreshGithubSource(db, row.id, {
      fetchImpl: async () => fakeResponse(404, { message: 'Not Found' }),
    });

    const [after] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, row.id));
    expect(after.fetchError).toMatch(/not found/i);
    expect(after.fetchedAt).not.toBeNull();
    // The row stays usable: prior content isn't wiped out by the failure.
    expect(after.description).toBe('previously fetched description');
  });

  it('stores a distinct error for a rate-limited 403', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'limited',
        url: 'https://github.com/acme/limited',
      })
      .returning();

    await refreshGithubSource(db, row.id, {
      fetchImpl: async () =>
        fakeResponse(403, { message: 'rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }),
    });

    const [after] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, row.id));
    expect(after.fetchError).toMatch(/rate limit/i);
  });

  it('stores a distinct error for an ordinary 403 (not rate-limited)', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'forbidden',
        url: 'https://github.com/acme/forbidden',
      })
      .returning();

    await refreshGithubSource(db, row.id, {
      fetchImpl: async () => fakeResponse(403, { message: 'blocked' }),
    });

    const [after] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, row.id));
    expect(after.fetchError).toMatch(/403/);
    expect(after.fetchError).not.toMatch(/rate limit/i);
  });

  it('stores a distinct error for a network failure', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'offline',
        url: 'https://github.com/acme/offline',
      })
      .returning();

    await refreshGithubSource(db, row.id, {
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });

    const [after] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, row.id));
    expect(after.fetchError).toMatch(/network error/i);
    expect(after.fetchError).toMatch(/ECONNRESET/);
  });

  it('skips a second refresh while the cache is within the TTL', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'cached',
        url: 'https://github.com/acme/cached',
      })
      .returning();

    let calls = 0;
    const fetchImpl: GithubFetch = async (url) => {
      calls += 1;
      return successfulFetch()(url);
    };

    await refreshGithubSource(db, row.id, { fetchImpl, ttlMs: 60_000 });
    expect(calls).toBe(3); // repo + readme + commits

    await refreshGithubSource(db, row.id, { fetchImpl, ttlMs: 60_000 });
    expect(calls).toBe(3); // second call skipped entirely: still fresh

    // A near-zero TTL makes the cache immediately stale again.
    await refreshGithubSource(db, row.id, { fetchImpl, ttlMs: 0 });
    expect(calls).toBe(6);
  });

  it('turns a README full of badges into prose, not badge markup', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'badged',
        url: 'https://github.com/acme/badged',
      })
      .returning();

    const readme = [
      '[![Build Status](https://img.shields.io/build.svg)](https://ci.example.com)',
      '![Coverage](https://img.shields.io/cov.svg) ![License](https://img.shields.io/lic.svg)',
      '<!-- a note nobody should read -->',
      '',
      '# Widget',
      '',
      'Widget does the thing, reliably, for people who need the thing done.',
    ].join('\n');

    await refreshGithubSource(db, row.id, { fetchImpl: successfulFetch(readme), ttlMs: 60_000 });

    const [after] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, row.id));
    expect(after.readmeExcerpt).not.toMatch(/shields\.io/);
    expect(after.readmeExcerpt).not.toMatch(/nobody should read/);
    expect(after.readmeExcerpt).toContain('Widget does the thing');
  });

  it('drops raw HTML so the excerpt starts at the first real sentence', async () => {
    // Measured against this repo's own README on 2026-09-07: the excerpt began
    // with a `<p align="left">` holding two `<img>` wordmarks, so the first
    // 200 characters a prompt received were markup. A README is allowed to be
    // HTML on GitHub; a prompt has no use for it.
    const orgId = await setupOrg();
    const db = getDb();
    const [row] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'htmlish',
        url: 'https://github.com/acme/htmlish',
      })
      .returning();

    const readme = [
      '<p align="left"><img src="assets/wordmark-dark.svg#gh-dark-mode-only" alt="Widget" height="64"><img src="assets/wordmark-light.svg" alt="Widget" height="64"></p>',
      '',
      'Widget does the thing, reliably, for people who need the thing done.',
      '',
      '<div align="center">',
      '  <b>Bold</b> claims belong in prose, not in a div.',
      '</div>',
    ].join('\n');

    await refreshGithubSource(db, row.id, { fetchImpl: successfulFetch(readme), ttlMs: 60_000 });

    const [after] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, row.id));
    expect(after.readmeExcerpt?.startsWith('Widget does the thing')).toBe(true);
    expect(after.readmeExcerpt).not.toMatch(/</);
    expect(after.readmeExcerpt).toContain('Bold claims belong in prose');
  });
});

describe('addGithubSource / listGithubSources / removeGithubSource', () => {
  it('adds, fetches inline, lists, and removes within one organization', async () => {
    const orgId = await setupOrg();
    const db = getDb();

    const added = await addGithubSource(db, orgId, 'https://github.com/acme/widget', {
      fetchImpl: successfulFetch(),
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('unreachable');
    expect(added.source.description).toBe('A test repo');

    const listed = await listGithubSources(db, orgId);
    expect(listed.map((s) => s.id)).toEqual([added.source.id]);

    const removed = await removeGithubSource(db, orgId, added.source.id);
    expect(removed).toBe(true);
    expect(await listGithubSources(db, orgId)).toEqual([]);
  });

  it('rejects a duplicate owner/repo within the same organization', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    await addGithubSource(db, orgId, 'acme/widget', { fetchImpl: successfulFetch() });
    const second = await addGithubSource(db, orgId, 'acme/widget', {
      fetchImpl: successfulFetch(),
    });
    expect(second).toMatchObject({ ok: false, code: 'duplicate' });
  });

  it('does not remove or leak a source id belonging to a different organization', async () => {
    const orgA = await setupOrg();
    const orgB = await setupOrg();
    const db = getDb();
    const added = await addGithubSource(db, orgA, 'acme/widget', { fetchImpl: successfulFetch() });
    if (!added.ok) throw new Error('unreachable');

    const removedFromWrongOrg = await removeGithubSource(db, orgB, added.source.id);
    expect(removedFromWrongOrg).toBe(false);

    // Still there, scoped to orgA, invisible to orgB.
    expect(await listGithubSources(db, orgA)).toHaveLength(1);
    expect(await listGithubSources(db, orgB)).toHaveLength(0);
  });
});

describe('refreshStaleGithubSources', () => {
  it('refreshes only sources whose cache is missing or past the TTL', async () => {
    const orgId = await setupOrg();
    const db = getDb();
    const [fresh] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'fresh',
        url: 'https://github.com/acme/fresh',
        fetchedAt: new Date(),
      })
      .returning();
    const [neverFetched] = await db
      .insert(schema.githubSources)
      .values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'new',
        url: 'https://github.com/acme/new',
      })
      .returning();

    const calledFor: string[] = [];
    const fetchImpl: GithubFetch = async (url) => {
      calledFor.push(url);
      return successfulFetch()(url);
    };

    const attempted = await refreshStaleGithubSources(db, { fetchImpl, ttlMs: 60_000 });
    expect(attempted).toBe(1);
    expect(calledFor.some((u) => u.includes('acme/new'))).toBe(true);
    expect(calledFor.some((u) => u.includes('acme/fresh'))).toBe(false);

    const [freshAfter] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, fresh.id));
    expect(freshAfter.fetchError).toBeNull();
    const [newAfter] = await db
      .select()
      .from(schema.githubSources)
      .where(eq(schema.githubSources.id, neverFetched.id));
    expect(newAfter.description).toBe('A test repo');
  });
});
