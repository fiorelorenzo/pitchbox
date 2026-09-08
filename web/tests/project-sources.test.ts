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
        .values({ projectId, kind: 'github', config: { value: 'acme/widget' } });

      const res = await GET(ev(orgId, 'member', projectId));
      const body = (await res.json()) as { sources: Array<{ kind: string }> };
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0].kind).toBe('github');
    });

    it("never returns another project's sources, and 404s a foreign project id", async () => {
      const { orgId: orgA, projectId: projectA } = await seedOrgWithProject(
        `ps-scope-a-${Date.now()}`,
      );
      const { projectId: projectB } = await seedOrgWithProject(`ps-scope-b-${Date.now()}`);
      await getDb()
        .insert(schema.projectSources)
        .values({ projectId: projectB, kind: 'github', config: { value: 'acme/widget' } });

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
        body: { kind: 'github', value: 'acme/widget' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 403 });
      expect(await countSources(projectId)).toBe(0);
    });

    it('an admin adds a source and it is synced inline', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-post-admin-${Date.now()}`);
      const event = ev(orgId, 'admin', projectId, {
        method: 'POST',
        body: { kind: 'github', value: 'https://github.com/acme/widget' },
      });
      const res = await POST(event);
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        source: { id: number; fetchError: string | null; output: { description: string } | null };
      };
      expect(body.source.fetchError).toBeNull();
      expect(body.source.output?.description).toBe('A test repo');
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
        body: { kind: 'github', value: 'acme/widget' },
      });
      await expect(POST(event)).rejects.toMatchObject({ status: 404 });
      expect(await countSources(projectB)).toBe(0);
    });
  });

  describe('POST .../sync', () => {
    it('rejects a member with 403', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-sync-member-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'github', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgId, 'member', projectId, { method: 'POST', sourceId: String(source.id) });
      await expect(SYNC(event)).rejects.toMatchObject({ status: 403 });
    });

    it('an admin re-syncs and gets fresh fetch state back', async () => {
      const { orgId, projectId } = await seedOrgWithProject(`ps-sync-admin-${Date.now()}`);
      const [source] = await getDb()
        .insert(schema.projectSources)
        .values({ projectId, kind: 'github', config: { value: 'acme/widget' } })
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
        .values({ projectId, kind: 'github', config: { value: 'acme/widget' } })
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
        .values({ projectId, kind: 'github', config: { value: 'acme/widget' } })
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
        .values({ projectId: projectA, kind: 'github', config: { value: 'acme/widget' } })
        .returning();
      const event = ev(orgB, 'admin', projectA, { method: 'DELETE', sourceId: String(source.id) });
      await expect(DELETE(event)).rejects.toMatchObject({ status: 404 });
      expect(await countSources(projectA)).toBe(1);
    });
  });
});
