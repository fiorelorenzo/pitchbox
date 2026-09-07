// Exercises web/src/routes/api/settings/github-sources: the admin-gated
// add/list/remove endpoints backing Settings' "what you have shipped"
// section. Role enforcement and organization scoping are the contract this
// locks down - the actual GitHub fetch is @pitchbox/shared/github-sources'
// job and is covered there, so `fetch` is stubbed globally here rather than
// hitting the network.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { GET, POST } from '../src/routes/api/settings/github-sources/+server.js';
import { DELETE } from '../src/routes/api/settings/github-sources/[id]/+server.js';

const createdOrgIds: number[] = [];

async function seedOrg(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

function ev(
  orgId: number,
  role: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; id?: string } = {},
): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    params: opts.id !== undefined ? { id: opts.id } : {},
    request: new Request('http://test.local/api/settings/github-sources', {
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
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const REPO_JSON = { description: 'A test repo', language: 'TypeScript' };

async function exists(id: number): Promise<boolean> {
  const [row] = await getDb()
    .select()
    .from(schema.githubSources)
    .where(eq(schema.githubSources.id, id));
  return row !== undefined;
}

describe('api/settings/github-sources', () => {
  beforeEach(() => {
    // GitHub's own three calls (repo, readme, commits) all succeed by
    // default; individual tests override this when they need a specific
    // status.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/readme')) return fakeResponse(404, {});
        if (String(url).includes('/commits')) return fakeResponse(200, []);
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
    it("lists only the caller org's sources, no role required", async () => {
      const orgId = await seedOrg(`ghs-get-${Date.now()}`);
      const db = getDb();
      await db.insert(schema.githubSources).values({
        organizationId: orgId,
        owner: 'acme',
        repo: 'widget',
        url: 'https://github.com/acme/widget',
      });

      const res = await GET(ev(orgId, 'member'));
      const body = (await res.json()) as { sources: Array<{ owner: string; repo: string }> };
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0]).toMatchObject({ owner: 'acme', repo: 'widget' });
    });

    it("never returns another organization's sources", async () => {
      const orgA = await seedOrg(`ghs-scope-a-${Date.now()}`);
      const orgB = await seedOrg(`ghs-scope-b-${Date.now()}`);
      const db = getDb();
      await db.insert(schema.githubSources).values({
        organizationId: orgA,
        owner: 'acme',
        repo: 'widget',
        url: 'https://github.com/acme/widget',
      });

      const res = await GET(ev(orgB, 'member'));
      const body = (await res.json()) as { sources: unknown[] };
      expect(body.sources).toHaveLength(0);
    });
  });

  describe('POST', () => {
    it('rejects a member with 403 and creates nothing', async () => {
      const orgId = await seedOrg(`ghs-post-member-${Date.now()}`);
      const event = ev(orgId, 'member', { method: 'POST', body: { url: 'acme/widget' } });
      await expect(POST(event)).rejects.toMatchObject({ status: 403 });
      const rows = await getDb()
        .select()
        .from(schema.githubSources)
        .where(eq(schema.githubSources.organizationId, orgId));
      expect(rows).toHaveLength(0);
    });

    it('allows an admin to add a repo, fetched inline', async () => {
      const orgId = await seedOrg(`ghs-post-admin-${Date.now()}`);
      const event = ev(orgId, 'admin', {
        method: 'POST',
        body: { url: 'https://github.com/acme/widget' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { source: { id: number; description: string } };
      expect(body.source.description).toBe('A test repo');
      expect(await exists(body.source.id)).toBe(true);
    });

    it('400s an unparseable URL without creating a row', async () => {
      const orgId = await seedOrg(`ghs-post-invalid-${Date.now()}`);
      const event = ev(orgId, 'admin', {
        method: 'POST',
        body: { url: 'https://gitlab.com/acme/widget' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 400 });
      const rows = await getDb()
        .select()
        .from(schema.githubSources)
        .where(eq(schema.githubSources.organizationId, orgId));
      expect(rows).toHaveLength(0);
    });

    it('409s a duplicate owner/repo in the same organization', async () => {
      const orgId = await seedOrg(`ghs-post-dup-${Date.now()}`);
      await POST(ev(orgId, 'admin', { method: 'POST', body: { url: 'acme/widget' } }));
      await expect(
        POST(ev(orgId, 'admin', { method: 'POST', body: { url: 'acme/widget' } })),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('DELETE', () => {
    it('rejects a member with 403 and leaves the row in place', async () => {
      const orgId = await seedOrg(`ghs-del-member-${Date.now()}`);
      const [row] = await getDb()
        .insert(schema.githubSources)
        .values({
          organizationId: orgId,
          owner: 'acme',
          repo: 'widget',
          url: 'https://github.com/acme/widget',
        })
        .returning();
      const event = ev(orgId, 'member', { id: String(row.id) });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 403 });
      expect(await exists(row.id)).toBe(true);
    });

    it("allows an admin to remove their own org's source", async () => {
      const orgId = await seedOrg(`ghs-del-admin-${Date.now()}`);
      const [row] = await getDb()
        .insert(schema.githubSources)
        .values({
          organizationId: orgId,
          owner: 'acme',
          repo: 'widget',
          url: 'https://github.com/acme/widget',
        })
        .returning();
      const event = ev(orgId, 'admin', { id: String(row.id) });
      const res = await DELETE(event);
      expect(res.status).toBe(204);
      expect(await exists(row.id)).toBe(false);
    });

    it('404s (not 403) a source id belonging to a different organization', async () => {
      const orgA = await seedOrg(`ghs-del-cross-a-${Date.now()}`);
      const orgB = await seedOrg(`ghs-del-cross-b-${Date.now()}`);
      const [row] = await getDb()
        .insert(schema.githubSources)
        .values({
          organizationId: orgA,
          owner: 'acme',
          repo: 'widget',
          url: 'https://github.com/acme/widget',
        })
        .returning();
      // orgB's caller is an admin - if org scoping didn't bite, the role
      // check alone would let this through.
      const event = ev(orgB, 'admin', { id: String(row.id) });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 404 });
      expect(await exists(row.id)).toBe(true);
    });

    it('404s for an id that does not exist', async () => {
      const orgId = await seedOrg(`ghs-del-missing-${Date.now()}`);
      const event = ev(orgId, 'admin', { id: '999999' });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 404 });
    });

    it('400s for a non-numeric id', async () => {
      const orgId = await seedOrg(`ghs-del-invalid-${Date.now()}`);
      const event = ev(orgId, 'admin', { id: 'abc' });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 400 });
    });
  });
});
