import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { DELETE as projectDelete } from '../src/routes/api/projects/[id]/+server.js';
import { PUT as webhooksPut } from '../src/routes/api/settings/webhooks/+server.js';

/**
 * requireRole enforcement on the admin-gated API routes (docs/permissions.md).
 * Covers the role matrix (member rejected, admin/owner allowed, no-op when
 * auth is off) via two representative handlers:
 *  - DELETE /api/projects/[id]: tenant-guarded AND role-gated - requireRole
 *    runs after the org-ownership check, so the target project must belong
 *    to the caller's org to reach the role gate at all.
 *  - PUT /api/settings/webhooks: role-gated only, no tenant guard - the
 *    cleanest place to exercise the "no locals.org" no-op case, since a
 *    tenant-guarded route would 404 before ever reaching requireRole. (Not
 *    /api/settings/default-runner - that one is instance-admin-gated as of
 *    #137, not requireRole-gated; see instance-admin-gating.test.ts.)
 */

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

// Minimal version of the seedOrgWithProject factory used across the
// route-guards-*.test.ts files - only org + project are needed here, no
// campaign/account/run, since deleteProject only reads the project row.
async function seedOrgWithProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${slug}-proj`,
      name: `${slug} project`,
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  return { orgId: org.id, projectId: project.id, projectSlug: project.slug };
}

function deleteProjectEvent(
  locals: Record<string, unknown>,
  projectId: number,
  confirmSlug: string,
): RequestEvent {
  return {
    locals,
    params: { id: String(projectId) },
    request: new Request(`http://x/api/projects/${projectId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmSlug }),
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as RequestEvent;
}

function webhooksPutEvent(locals: Record<string, unknown>): RequestEvent {
  return {
    locals,
    request: new Request('http://x/api/settings/webhooks', {
      method: 'PUT',
      body: JSON.stringify({ url: null }),
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as RequestEvent;
}

describe('per-role permission enforcement (requireRole)', () => {
  beforeEach(reset);

  describe('DELETE /api/projects/[id] (admin-gated, tenant-guarded)', () => {
    it('rejects a member with 403', async () => {
      const a = await seedOrgWithProject('re-proj-member');
      const event = deleteProjectEvent(
        { org: { id: a.orgId, slug: 'x', role: 'member' } },
        a.projectId,
        a.projectSlug,
      );
      await expect(projectDelete(event)).rejects.toMatchObject({ status: 403 });
    });

    it('allows an admin', async () => {
      const a = await seedOrgWithProject('re-proj-admin');
      const event = deleteProjectEvent(
        { org: { id: a.orgId, slug: 'x', role: 'admin' } },
        a.projectId,
        a.projectSlug,
      );
      const res = await projectDelete(event);
      expect(res.status).toBe(200);
    });

    it('allows an owner', async () => {
      const a = await seedOrgWithProject('re-proj-owner');
      const event = deleteProjectEvent(
        { org: { id: a.orgId, slug: 'x', role: 'owner' } },
        a.projectId,
        a.projectSlug,
      );
      const res = await projectDelete(event);
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/settings/webhooks (admin-gated, no tenant guard)', () => {
    it('rejects a member with 403', async () => {
      const event = webhooksPutEvent({ org: { id: 1, slug: 'x', role: 'member' } });
      await expect(webhooksPut(event)).rejects.toMatchObject({ status: 403 });
    });

    it('allows an admin', async () => {
      const event = webhooksPutEvent({ org: { id: 1, slug: 'x', role: 'admin' } });
      const res = await webhooksPut(event);
      expect(res.status).toBe(200);
    });

    it('allows an owner', async () => {
      const event = webhooksPutEvent({ org: { id: 1, slug: 'x', role: 'owner' } });
      const res = await webhooksPut(event);
      expect(res.status).toBe(200);
    });

    it('is a no-op when locals.org is unset (auth off / self-host)', async () => {
      const event = webhooksPutEvent({});
      const res = await webhooksPut(event);
      expect(res.status).toBe(200);
    });
  });
});
