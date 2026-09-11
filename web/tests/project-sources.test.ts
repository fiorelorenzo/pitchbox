// Exercises web/src/routes/api/projects/[id]/sources: the add/list/sync/
// remove endpoints backing ProjectSourcesPanel.svelte (#432). Role
// enforcement (admin-gated writes) and organization scoping (a project from
// a different org 404s, never a 403 that would confirm the id exists) are
// the contract this locks down - the actual GitHub fetch is
// @pitchbox/shared/project-source-sync's job and is covered there, so
// `fetch` is stubbed globally here rather than hitting the network.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { GET, POST } from '../src/routes/api/projects/[id]/sources/+server.js';
import { DELETE } from '../src/routes/api/projects/[id]/sources/[sourceId]/+server.js';
import { POST as SYNC } from '../src/routes/api/projects/[id]/sources/[sourceId]/sync/+server.js';

const createdOrgIds: number[] = [];

async function seedOrgWithProject(slug: string): Promise<{ orgId: number; projectId: number }> {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function ev(
  orgId: number,
  role: string,
  projectId: number,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; sourceId?: string } = {},
): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    params: {
      id: String(projectId),
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
    },
    request: new Request('http://test.local/api/projects/x/sources', {
      method: opts.method ?? 'GET',
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } }
        : {}),
    }),
  } as unknown as RequestEvent;
}

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

const REPO_JSON = { description: 'A test repo', language: 'TypeScript' };

async function countSources(projectId: number): Promise<number> {
  const rows = await getDb()
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.projectId, projectId));
  return rows.length;
}

describe('api/projects/[id]/sources', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/readme')) return fakeResponse(404, {});
        return fakeResponse(200, REPO_JSON);
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const db = getDb();
    while (createdOrgIds.length > 0) {
      const id = createdOrgIds.pop()!;
      await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
  });

  describe('GET', () => {
    it("lists only the caller project's sources, no role required", async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-get-${Date.now()}`);
      await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'git', config: { value: 'acme/widget' } });

      const res = await GET(ev(orgId, 'member', projectId));
      const body = (await res.json()) as { sources: Array<{ kind: string }> };
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0].kind).toBe('git');
    });

    it("never returns another project's sources, and 404s a foreign project id", async () => {
      const { orgId: orgA, projectId: projectA } = await seedOrgWithProject(
        `ps-scope-a-${Date.now()}`,
      );
      const { projectId: projectB } = await seedOrgWithProject(`ps-scope-b-${Date.now()}`);
      await getDb()
        .insert(schema.projectSources)
        .values({ projectId: projectB, kind: 'git', config: { value: 'acme/widget' } });

      await expect(GET(ev(orgA, 'member', projectB))).rejects.toMatchObject({ status: 404 });
      const res = await GET(ev(orgA, 'member', projectA));
      const body = (await res.json()) as { sources: unknown[] };
      expect(body.sources).toHaveLength(0);
    });
  });

  describe('POST', () => {
    it('rejects a member with 403 and creates nothing', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-member-${Date.now()}`);
      const event = ev(orgId, 'member', projectId, {
        method: 'POST',
        body: { kind: 'git', value: 'acme/widget' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 403 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('an admin adds a source and it is synced inline', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-admin-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'git', value: 'https://github.com/acme/widget' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        source: { id: number; fetchError: string | null; output: { description: string } | null };
      };
      expect(body.source.fetchError).toBeNull();
      expect(body.source.output?.description).toBe('A test repo');
    });

    it('stores a GitHub shorthand as the https URL a clone can actually use', async () => {
      // `owner/repo` is the natural thing to type and the one thing `git
      // clone` refuses, so a row that syncs through the API but cannot be
      // cloned is the exact trap this normalisation removes.
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-shorthand-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'git', value: 'acme/widget' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { source: { config: { value: string } } };
      expect(body.source.config.value).toBe('https://github.com/acme/widget');
    });

    it('refuses a repository value git itself would reject, creating nothing', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-badrepo-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'git', value: 'ext::sh -c whoami' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 400 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('rejects folder/upload kinds - not addable through this endpoint', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-folder-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'folder', value: '/tmp/x' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 400 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('404s a foreign project id and creates nothing', async () => {
      const { orgId: orgA } = await seedOrgWithProject(`ps-post-scope-a-${Date.now()}`);
      const { projectId: projectB } = await seedOrgWithProject(`ps-post-scope-b-${Date.now()}`);
      const event = ev(orgA, 'admin', projectB, {
        method: 'POST',
        body: { kind: 'git', value: 'acme/widget' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 404 });
      expect(await countSources(projectB)).toBe(0);
    });
  });

  describe('POST: website / mastodon_account / hackernews_author', () => {
    it('adds a website source, storing config.url (not config.value) and real fetched text', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-website-${Date.now()}`);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          body: null,
          text: async () => '<h1>Acme</h1><p>We make widgets.</p>',
        })) as unknown as typeof fetch,
      );
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'website', value: 'https://example.com/' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        source: {
          kind: string;
          config: unknown;
          fetchError: string | null;
          output: { text: string };
        };
      };
      expect(body.source.kind).toBe('website');
      expect(body.source.config).toEqual({ url: 'https://example.com/' });
      expect(body.source.fetchError).toBeNull();
      expect(body.source.output.text).toContain('We make widgets.');
    });

    it('rejects an invalid website URL with 400 and creates nothing', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-website-bad-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'website', value: 'ftp://example.com' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 400 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('adds a mastodon_account source, splitting the profile URL into instanceUrl/acct', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-mastodon-${Date.now()}`);
      const account = { id: '9', acct: 'alice', display_name: 'Alice' };
      const statuses = [{ id: '1', content: '<p>Hello world.</p>' }];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).includes('/lookup')
            ? fakeResponse(200, account)
            : fakeResponse(200, statuses),
        ),
      );
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'mastodon_account', value: 'https://mastodon.social/@alice' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        source: { kind: string; config: unknown; fetchError: string | null };
      };
      expect(body.source.kind).toBe('mastodon_account');
      expect(body.source.config).toEqual({ instanceUrl: 'https://mastodon.social', acct: 'alice' });
      expect(body.source.fetchError).toBeNull();
    });

    it('rejects a non-profile Mastodon URL with 400 and creates nothing', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-mastodon-bad-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'mastodon_account', value: 'https://example.com' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 400 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('adds a hackernews_author source from a bare username, not a URL', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-hn-${Date.now()}`);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).includes('/user/')
            ? fakeResponse(200, { id: 'pg', submitted: [1] })
            : fakeResponse(200, { id: 1, type: 'story', by: 'pg', title: 'Ask HN: something' }),
        ),
      );
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'hackernews_author', value: 'pg' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        source: { kind: string; config: unknown; output: { text: string } };
      };
      expect(body.source.kind).toBe('hackernews_author');
      expect(body.source.config).toEqual({ username: 'pg' });
      expect(body.source.output.text).toContain('Ask HN: something');
    });

    it('rejects an invalid HN username with 400 and creates nothing', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-hn-bad-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'hackernews_author', value: 'https://news.ycombinator.com/item?id=1' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 400 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('re-syncs a mastodon_account source through .../sync', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-sync-mastodon-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({
          projectId,
          kind: 'mastodon_account',
          config: { instanceUrl: 'https://mastodon.example', acct: 'alice' },
        })
        .returning();
      const account = { id: '9', acct: 'alice', display_name: 'Alice' };
      const statuses = [{ id: '1', content: '<p>Fresh post.</p>' }];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).includes('/lookup')
            ? fakeResponse(200, account)
            : fakeResponse(200, statuses),
        ),
      );
      const event = ev(orgId, 'admin', projectId, { method: 'POST', sourceId: String(source.id) });
      const res = await SYNC(event);
      const body = (await res.json()) as { ok: boolean; source: { output: { text: string } } };
      expect(body.ok).toBe(true);
      expect(body.source.output.text).toContain('Fresh post.');
    });
  });

  describe('POST .../sync', () => {
    it('rejects a member with 403', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-sync-member-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'git', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgId, 'member', projectId, { method: 'POST', sourceId: String(source.id) });
      await expect(SYNC(event)).rejects.toMatchObject({ status: 403 });
    });

    it('an admin re-syncs and gets fresh fetch state back', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-sync-admin-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'git', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgId, 'admin', projectId, { method: 'POST', sourceId: String(source.id) });
      const res = await SYNC(event);
      const body = (await res.json()) as { ok: boolean; source: { fetchedAt: string | null } };
      expect(body.ok).toBe(true);
      expect(body.source.fetchedAt).not.toBeNull();
    });
  });

  describe('DELETE', () => {
    it('rejects a member with 403 and removes nothing', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-del-member-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'git', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgId, 'member', projectId, {
        method: 'DELETE',
        sourceId: String(source.id),
      });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 403 });
      expect(await countSources(projectId)).toBe(1);
    });

    it('an admin removes a source', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-del-admin-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'git', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgId, 'admin', projectId, {
        method: 'DELETE',
        sourceId: String(source.id),
      });
      const res = await DELETE(event);
      expect(res.status).toBe(200);
      expect(await countSources(projectId)).toBe(0);
    });

    it("404s a source belonging to another project's organization, removing nothing", async () => {
      const { projectId: projectA } = await seedOrgWithProject(`ps-del-scope-a-${Date.now()}`);
      const { orgId: orgB } = await seedOrgWithProject(`ps-del-scope-b-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId: projectA, kind: 'git', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgB, 'admin', projectA, { method: 'DELETE', sourceId: String(source.id) });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 404 });
      expect(await countSources(projectA)).toBe(1);
    });
  });
});
